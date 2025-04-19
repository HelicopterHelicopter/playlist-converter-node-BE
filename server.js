require('dotenv').config(); // Load .env file variables

const express = require('express');
const cors = require('cors');
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

// Tell Express to trust the headers set by the first proxy in front of it
// This is crucial for secure cookies and correct IP identification behind proxies
// app.set('trust proxy', 1); // REMOVE (No longer needed for cookies)

// --- Middleware ---

// CORS
app.use(cors({
    origin: 'https://convert.jheels.in', // Explicitly allow requests from frontend URL
    credentials: true      // Allow cookies to be sent - MAYBE REMOVE LATER if no cookies used at all
}));

// Cookie Parser
// app.use(cookieParser()); // REMOVE

// Body Parsers
app.use(express.json()); // For parsing application/json
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded

// Session Management
// app.use(session({ ... })); // REMOVE ENTIRE BLOCK

// Middleware to attach Spotify API client with user tokens if available
// Also handles token refresh
// app.use(async (req, res, next) => { ... }); // REMOVE ENTIRE BLOCK

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

    // Use the FRONTEND_URL from environment for redirects
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'; // Fallback needed

    if (error) {
        console.error('Spotify Callback Error:', error);
        // Redirect with error in fragment for frontend to parse
        return res.redirect(`${frontendUrl}/auth/callback#error=spotify_login_${encodeURIComponent(error)}`);
    }
    if (!code) {
        console.error('Spotify Callback: No code received.');
        // Redirect with error in fragment
        return res.redirect(`${frontendUrl}/auth/callback#error=spotify_no_code`);
    }

    // TODO: Validate state if used during login

    try {
        // Use the global spotifyApi instance to exchange code for tokens
        console.log('[CALLBACK] Exchanging code for tokens...');
        const data = await spotifyApi.authorizationCodeGrant(code);
        const { access_token, refresh_token, expires_in } = data.body;
        console.log('[CALLBACK] Tokens received successfully.');

        // ** DO NOT STORE IN SESSION **
        // req.session.spotify_tokens = { ... };
        // req.session.spotify_user_id = ...;
        // console.log(`Successfully obtained Spotify token for user: ${me.body.id}`);

        // ** DO NOT SAVE SESSION **
        // req.session.save(...);

        // Construct the redirect URL with tokens in the fragment (#)
        const redirectUrl = new URL(`${frontendUrl}/auth/callback`);
        redirectUrl.hash = new URLSearchParams({
            access_token: access_token,
            refresh_token: refresh_token,
            expires_in: expires_in.toString()
        }).toString();

        console.log(`[CALLBACK] Redirecting to frontend with tokens in fragment.`);
        res.redirect(redirectUrl.toString());

    } catch (err) {
        console.error('Error getting Spotify tokens:', err.message || err);
        // Redirect with error in fragment
        const errorMsg = err.message || 'unknown_token_error';
        res.redirect(`${frontendUrl}/auth/callback#error=spotify_token_${encodeURIComponent(errorMsg)}`);
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