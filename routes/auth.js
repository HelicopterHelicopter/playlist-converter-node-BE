const express = require('express');

module.exports = function(dependencies) {
    const router = express.Router();
    const { spotifyApi, spotifyApiScope } = dependencies; // Destructure needed deps

    // GET /api/auth/status
    router.get('/status', async (req, res) => {
        if (req.userSpotifyApi && req.session.spotify_user_id) {
            // We have an active, potentially refreshed client and user ID
            try {
                // Optional: Fetch minimal user info to confirm token validity
                const me = await req.userSpotifyApi.getMe();
                res.json({
                    logged_in: true,
                    user: {
                        id: me.body.id,
                        display_name: me.body.display_name,
                        image: me.body.images?.[0]?.url || null
                    }
                });
            } catch (err) {
                // If getMe fails even after potential refresh, token is likely invalid
                console.error('Error verifying token with getMe():', err.message);
                req.session.destroy(); // Clear invalid session
                res.json({ logged_in: false, error: "Failed to verify token." });
            }
        } else {
            // Not logged in or session missing info
            res.json({ logged_in: false });
        }
    });

    // GET /api/auth/login
    router.get('/login', (req, res) => {
        // Use the spotifyApi passed in via dependencies
        // const spotifyApiScope = ['playlist-modify-public', 'playlist-modify-private', 'user-read-private']; // This will be passed in now
        // Optional: Add state parameter for security
        // const state = require('crypto').randomBytes(16).toString('hex');
        // req.session.spotify_auth_state = state; // Store state in session
        const authorizeURL = spotifyApi.createAuthorizeURL(spotifyApiScope /*, state */);
        console.log(`Redirecting to Spotify auth: ${authorizeURL}`);
        res.redirect(authorizeURL);
    });

    // GET /api/auth/logout
    router.get('/logout', (req, res) => {
        req.session.destroy((err) => {
            if (err) {
                console.error("Session destruction error during logout:", err);
                return res.status(500).json({ error: "Failed to logout properly." });
            }
            // Optional: Clear site cookie explicitly if needed, though session destroy usually handles it
            // res.clearCookie('connect.sid'); // Default session cookie name
            console.log("Logged out from Spotify session.");
            res.status(200).json({ message: "Logged out successfully." });
        });
    });

    return router; // Return the configured router
}; 