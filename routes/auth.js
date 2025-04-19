const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node'); // Need this for temporary client

module.exports = function(dependencies) {
    const router = express.Router();
    // Destructure only what's needed now (global spotifyApi for refresh, potentially scope?)
    const { spotifyApi, spotifyApiScope } = dependencies;

    // Middleware to extract Authorization Bearer token
    const extractToken = (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            req.token = authHeader.substring(7); // Extract token part
        } else {
            req.token = null;
        }
        next();
    };

    // GET /api/auth/status - Now expects Authorization header
    router.get('/status', extractToken, async (req, res) => {
        if (!req.token) {
            return res.json({ logged_in: false, reason: "No token provided" });
        }

        // Validate token by making a simple API call (e.g., getMe)
        try {
            // Create a temporary Spotify client with the provided token
            const userSpotifyApi = new SpotifyWebApi({
                clientId: process.env.SPOTIFY_CLIENT_ID, // Needed, ensure they are in env
                clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
                accessToken: req.token
            });
            const me = await userSpotifyApi.getMe();
            // If getMe succeeds, the token is valid
            res.json({
                logged_in: true,
                user: {
                    id: me.body.id,
                    display_name: me.body.display_name,
                    image: me.body.images?.[0]?.url || null
                }
            });
        } catch (err) {
            // Handle errors (e.g., token expired, invalid)
            console.error('[AUTH_STATUS] Error validating token:', err.message);
            let reason = "Token validation failed";
            if (err.statusCode === 401) {
                reason = "Invalid or expired token";
            }
            res.status(err.statusCode === 401 ? 401 : 500).json({ logged_in: false, reason: reason });
        }
    });

    // POST /api/auth/refresh - New endpoint to refresh token
    router.post('/refresh', async (req, res) => {
        const { refresh_token } = req.body;
        if (!refresh_token) {
            return res.status(400).json({ error: "Missing refresh_token in request body" });
        }

        try {
            // Use the globally configured spotifyApi instance
            spotifyApi.setRefreshToken(refresh_token);
            const data = await spotifyApi.refreshAccessToken();
            
            const new_access_token = data.body['access_token'];
            const new_expires_in = data.body['expires_in'];
            // Note: A new refresh token might sometimes be returned, but not always.
            // The frontend should ideally store it if received.
            const new_refresh_token = data.body['refresh_token']; 

            console.log('[AUTH_REFRESH] Access token refreshed successfully.');
            res.json({
                access_token: new_access_token,
                expires_in: new_expires_in,
                refresh_token: new_refresh_token // Send back if provided
            });

        } catch (err) {
            console.error('[AUTH_REFRESH] Could not refresh access token:', err.message);
            // Respond with an error, likely 401 if refresh token is invalid/revoked
            res.status(err.statusCode || 500).json({ error: "Failed to refresh token", reason: err.message });
        }
    });

    // GET /api/auth/login - Remains mostly the same, redirects to Spotify
    router.get('/login', (req, res) => {
        // Use the global spotifyApi instance to generate the authorization URL
        // Optional: Add state parameter for security
        const authorizeURL = spotifyApi.createAuthorizeURL(spotifyApiScope /*, state */);
        console.log(`Redirecting to Spotify auth: ${authorizeURL}`);
        res.redirect(authorizeURL);
    });

    // GET /api/auth/logout - REMOVED (Handled by frontend clearing storage)
    // router.get('/logout', ...);

    return router; // Return the configured router
}; 