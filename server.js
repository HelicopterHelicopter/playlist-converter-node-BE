require('dotenv').config(); // Load .env file variables

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { google } = require('googleapis');
const SpotifyWebApi = require('spotify-web-api-node');
const url = require('url'); // For URL parsing

// --- Configuration & Validation ---
const { 
    SESSION_SECRET,
    YOUTUBE_API_KEY,
    SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET,
    SPOTIFY_REDIRECT_URI,
    FRONTEND_URL,
    PORT 
} = process.env;

const requiredEnvVars = [
    'SESSION_SECRET', 'YOUTUBE_API_KEY', 'SPOTIFY_CLIENT_ID', 
    'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REDIRECT_URI', 'FRONTEND_URL', 'PORT'
];
const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);

if (missingEnvVars.length > 0) {
    console.error(`\n*** ERROR: Missing required environment variables: ${missingEnvVars.join(', ')} ***`);
    console.error("Please ensure they are set in your .env file.\n");
    process.exit(1);
}

const spotifyApiScope = ['playlist-modify-public', 'playlist-modify-private', 'user-read-private'];
const appPort = parseInt(PORT, 10);

// --- Initialize API Clients ---

// YouTube Client (using API Key)
const youtube = google.youtube({ version: 'v3', auth: YOUTUBE_API_KEY });

// Spotify Client
const spotifyApi = new SpotifyWebApi({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET,
    redirectUri: SPOTIFY_REDIRECT_URI
});

// Spotify Client Credentials Client (for search without user login)
let spotifySearchApi = null;
const initializeSearchClient = () => {
    const searchApiInstance = new SpotifyWebApi({
        clientId: SPOTIFY_CLIENT_ID,
        clientSecret: SPOTIFY_CLIENT_SECRET,
    });
    return searchApiInstance.clientCredentialsGrant().then(
        (data) => {
            console.log('Spotify search client credentials token expires in ' + data.body['expires_in']);
            searchApiInstance.setAccessToken(data.body['access_token']);
            spotifySearchApi = searchApiInstance;
            // Optional: Set up automatic refresh (complex, maybe do on demand)
        },
        (err) => {
            console.error('Could not initialize Spotify search client:', err.message);
            spotifySearchApi = null; // Ensure it's null on failure
        }
    );
};
// Initialize search client on startup
initializeSearchClient();

// --- Express App Setup ---
const app = express();

// --- Middleware ---

// CORS
app.use(cors({
    origin: FRONTEND_URL, // Allow requests from frontend URL
    credentials: true      // Allow cookies to be sent
}));

// Cookie Parser
app.use(cookieParser());

// Body Parsers
app.use(express.json()); // For parsing application/json
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded

// Session Management
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false, // Don't save session if unmodified
    cookie: {
        secure: process.env.NODE_ENV === 'production', // REQUIRED for sameSite: 'none'
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24, // Example: 1 day session cookie lifetime
        sameSite: 'none', // Allow cross-site cookie sending
        domain: '.jheels.in' // Set parent domain for cross-subdomain access
    }
}));

// Middleware to attach Spotify API client with user tokens if available
// Also handles token refresh
app.use(async (req, res, next) => {
    // Create a request-specific instance to avoid polluting the global one
    const userSpotifyApi = new SpotifyWebApi({
        clientId: SPOTIFY_CLIENT_ID,
        clientSecret: SPOTIFY_CLIENT_SECRET,
        redirectUri: SPOTIFY_REDIRECT_URI
    });

    if (req.session.spotify_tokens) {
        userSpotifyApi.setAccessToken(req.session.spotify_tokens.access_token);
        userSpotifyApi.setRefreshToken(req.session.spotify_tokens.refresh_token);

        // Check if token is expired (or close to expiring)
        const expiryTime = req.session.spotify_tokens.expiry_time;
        if (Date.now() >= expiryTime - 5 * 60 * 1000) { // Refresh if within 5 mins of expiry
            console.log('Refreshing Spotify access token...');
            try {
                const data = await userSpotifyApi.refreshAccessToken();
                const newAccessToken = data.body['access_token'];
                const newExpiresIn = data.body['expires_in'];
                const newExpiryTime = Date.now() + newExpiresIn * 1000;

                console.log('The access token has been refreshed!');
                userSpotifyApi.setAccessToken(newAccessToken);

                // Update session tokens (important: include refresh token if it changed)
                req.session.spotify_tokens = {
                    access_token: newAccessToken,
                    // Refresh token might or might not be returned on refresh, keep old one if not
                    refresh_token: data.body['refresh_token'] || req.session.spotify_tokens.refresh_token,
                    expiry_time: newExpiryTime
                };
                req.session.save(); // Explicitly save session after modification

            } catch (err) {
                console.error('Could not refresh Spotify access token', err.message);
                // Clear session if refresh fails
                req.session.destroy();
                // Don't attach the api to req if refresh failed
                req.userSpotifyApi = null;
                return next(); // Proceed without authenticated client
            }
        }
        // Attach the potentially refreshed API client to the request
        req.userSpotifyApi = userSpotifyApi;
    } else {
        req.userSpotifyApi = null; // No tokens in session
    }
    next();
});

// --- Helper Functions (Ported/Adapted from Python) ---

function getYoutubePlaylistId(playlistUrl) {
    try {
        const parsedUrl = new url.URL(playlistUrl);
        const hostname = parsedUrl.hostname.replace('www.', '');
        if (['music.youtube.com', 'youtube.com'].includes(hostname)) {
            return parsedUrl.searchParams.get('list');
        }
        // Handle youtu.be/playlist?list=...
        if (hostname === 'youtu.be' && parsedUrl.pathname === '/playlist') {
            return parsedUrl.searchParams.get('list');
        }
    } catch (e) {
        console.error(`Error parsing URL: ${playlistUrl}`, e.message);
    }
    console.log(`DEBUG: Could not parse playlist ID from URL: ${playlistUrl}`);
    return null;
}

function cleanYoutubeTitle(title) {
    if (!title) return "";
    let searchQuery = title.toLowerCase();
    // Remove common video/audio type indicators more broadly
    searchQuery = searchQuery.replace(/[\(\[].*?(official|music|video|audio|lyric|visualizer|hq|hd|4k|1080p|720p|live|session|explicit|remastered|album|ep|single|radio edit|remix).*?[\)\]]/gi, ' ');
    // Remove content after common separators like -, |, // etc. if it seems like extra info
    searchQuery = searchQuery.split(/\s+[-–|\/]+\s+/)[0];
    // Remove "feat." patterns
    searchQuery = searchQuery.replace(/\s+\(?(feat|ft)\.?\s+.*?\)?/gi, '');
    // Remove year in parentheses at the end
    searchQuery = searchQuery.replace(/\s*\(\d{4}\)\s*$/, '');
    // Remove extra whitespace
    searchQuery = searchQuery.replace(/\s+/g, ' ').trim();
    return searchQuery;
}


// --- API Routes ---

// Authentication Routes
const authRoutesSetup = require('./routes/auth'); // NEW: Require the setup function
// Pass dependencies to the setup function
app.use('/api/auth', authRoutesSetup({ 
    spotifyApi: spotifyApi, // Pass the global instance
    spotifyApiScope: spotifyApiScope // Pass the scope defined earlier
})); 

// Conversion Route
const convertRoutesSetup = require('./routes/convert'); // NEW: Require the setup function
// Pass dependencies to the setup function
app.use('/api/convert', convertRoutesSetup({ 
    youtube: youtube,
    spotifySearchApi: spotifySearchApi,
    getYoutubePlaylistId: getYoutubePlaylistId,
    cleanYoutubeTitle: cleanYoutubeTitle
}));

// Spotify Callback (Not under /api, matches registration)
app.get('/callback', async (req, res) => {
    const { code, error, state } = req.query;

    if (error) {
        console.error('Spotify Callback Error:', error);
        return res.redirect(`${FRONTEND_URL}?error=spotify_login_${error}`);
    }
    if (!code) {
        console.error('Spotify Callback: No code received.');
        return res.redirect(`${FRONTEND_URL}?error=spotify_no_code`);
    }

    // TODO: Validate state if used during login

    try {
        // Use the global spotifyApi instance to exchange code for tokens
        const data = await spotifyApi.authorizationCodeGrant(code);
        const { access_token, refresh_token, expires_in } = data.body;
        const expiry_time = Date.now() + expires_in * 1000;

        // Store tokens and expiry time in session
        req.session.spotify_tokens = {
            access_token,
            refresh_token,
            expiry_time
        };

        // Get user ID to store (optional, but useful)
        const tempApi = new SpotifyWebApi({ accessToken: access_token });
        const me = await tempApi.getMe();
        req.session.spotify_user_id = me.body.id;
        console.log(`Successfully obtained Spotify token for user: ${me.body.id}`);

        req.session.save((err) => {
            if (err) {
                console.error("Session save error after callback:", err);
                return res.redirect(`${FRONTEND_URL}?error=session_save_error`);
            }
             // Redirect back to the frontend application
            res.redirect(FRONTEND_URL);
        });

    } catch (err) {
        console.error('Error getting Spotify tokens:', err.message || err);
        res.redirect(`${FRONTEND_URL}?error=spotify_token_error`);
    }
});

// Basic Root Route (Optional - for testing if server is up)
app.get('/', (req, res) => {
    res.send('Playlist Converter Backend API is running.');
});

// --- Error Handling Middleware (Basic) ---
// Place after all routes
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error'
    });
});

// --- Start Server ---
app.listen(appPort, () => {
    console.log(`Backend API server listening on port ${appPort}`);
    console.log(`Allowed frontend origin: ${FRONTEND_URL}`);
    console.log(`Spotify Callback URI: ${SPOTIFY_REDIRECT_URI}`);
}); 