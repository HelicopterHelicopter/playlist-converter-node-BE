const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node'); // Need this for temporary client

// Middleware (can be shared or defined here) to extract Authorization Bearer token
const extractToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        req.token = authHeader.substring(7); // Extract token part
    } else {
        req.token = null;
    }
    next();
};

module.exports = function(dependencies) {
    const router = express.Router();
    const { 
        youtube,
        spotifySearchApi, // Client credentials client for searching
        getYoutubePlaylistId,
        cleanYoutubeTitle
    } = dependencies; // Destructure needed deps

    // --- YouTube Fetching Logic ---
    async function getYoutubePlaylistItems(playlistId) {
        let tracksData = [];
        let nextPageToken = null;
        try {
            do {
                const response = await youtube.playlistItems.list({
                    part: 'snippet',
                    playlistId: playlistId,
                    maxResults: 50,
                    pageToken: nextPageToken,
                });
                response.data.items.forEach(item => {
                    const snippet = item.snippet || {};
                    const title = snippet.title;
                    const channelTitle = snippet.videoOwnerChannelTitle;
                    // Check for unavailable videos
                    if (title && !['deleted video', 'private video'].includes(title.toLowerCase())) {
                        tracksData.push({
                            title: title,
                            channel: channelTitle || null
                        });
                    }
                });
                nextPageToken = response.data.nextPageToken;
            } while (nextPageToken);
            return tracksData;
        } catch (err) {
            console.error('YouTube API Error:', err.response ? JSON.stringify(err.response.data.error) : err.message);
            // Translate common error codes/reasons
            if (err.response && err.response.status === 404) {
                throw new Error("YouTube playlist not found or private.");
            } else if (err.response && err.response.status === 403) {
                 let reason = "API access forbidden";
                 const errorDetail = err.response.data.error?.errors?.[0]?.reason;
                 if (errorDetail === "quotaExceeded") reason = "API Quota Exceeded";
                 else if (errorDetail === "playlistItemsNotAccessible") reason = "Playlist items not accessible (private?)";
                 throw new Error(`YouTube Error: ${reason}. Check API key/permissions/quota.`);
            } else if (err.response && err.response.status === 400) {
                 throw new Error("Invalid YouTube Playlist ID format provided.");
            }
            throw new Error(`YouTube API Error (${err.response?.status || 'Unknown'})`);
        }
    }

    // --- Spotify Search Logic ---
    async function searchSpotifyTrack(sp, ytTrackData) {
        if (!sp) {
            console.warn("searchSpotifyTrack called with no Spotify client.");
            return null;
        }
        const { title: originalTitle, channel: channelName } = ytTrackData;
        if (!originalTitle) return null;

        const cleanedTitle = cleanYoutubeTitle(originalTitle);
        const cleanedChannel = channelName?.replace(/ - Topic|VEVO/gi, '').trim() || null;

        if (!cleanedTitle) return null;

        // Search Strategies (similar to Python version)
        let searchAttempts = [];
        if (cleanedChannel) {
            searchAttempts.push({ q: `track:"${cleanedTitle}" artist:"${cleanedChannel}"`, desc: 'Precise' });
            searchAttempts.push({ q: `"${cleanedTitle}" "${cleanedChannel}"`, desc: 'Combined' });
        }
        searchAttempts.push({ q: cleanedTitle, desc: 'Cleaned Title Only' });

        for (const attempt of searchAttempts) {
            console.log(`Searching Spotify [${attempt.desc}] for "${attempt.q}"...`);
            try {
                const results = await sp.searchTracks(attempt.q, { limit: 1 });
                if (results.body.tracks.items.length > 0) {
                    const trackInfo = results.body.tracks.items[0];
                    const foundArtists = trackInfo.artists.map(a => a.name).join(', ');
                    console.log(`  FOUND: ${trackInfo.name} by ${foundArtists} (${trackInfo.uri})`);
                    return trackInfo.uri;
                }
            } catch (err) {
                console.error(`  Spotify API error during search [${attempt.desc}] ${err.message}`);
                if (err.statusCode === 429) { // Rate limit
                    console.log("  Rate limit hit, stopping search for this track.");
                    break; // Stop trying for this track
                }
            }
        }
        console.log(`### No Spotify match found for YouTube track: '${originalTitle}' ###`);
        return null;
    }

    // --- Spotify Playlist Creation/Addition Logic ---
    async function createSpotifyPlaylist(accessToken, userId, playlistName) {
        if (!accessToken) throw new Error("Missing access token for Spotify operation.");
        // Create temporary client for this request
        const spUser = new SpotifyWebApi({ accessToken: accessToken });
        try {
            console.log(`Creating Spotify playlist '${playlistName}' for user ${userId}`);
            const playlist = await spUser.createPlaylist(playlistName, { 'public' : true });
            console.log(`Successfully created playlist: ${playlist.body.name} (${playlist.body.id})`);
            return playlist.body.uri;
        } catch (err) {
            console.error(`Spotify API error creating playlist: ${err.message}`);
            throw new Error(`Could not create playlist: ${err.message} (Status: ${err.statusCode})`);
        }
    }

    async function addTracksToSpotifyPlaylist(accessToken, playlistUri, trackUris) {
        if (!accessToken) throw new Error("Missing access token for Spotify operation.");
        if (!trackUris || trackUris.length === 0) return { success: true, added_count: 0 };
        
        // Create temporary client for this request
        const spUser = new SpotifyWebApi({ accessToken: accessToken });
        const playlistId = playlistUri.split(':')[2]; // Extract ID from URI
        let addedCount = 0;
        let errors = [];
        console.log(`Adding ${trackUris.length} tracks to Spotify playlist ${playlistId}`);

        // Add tracks in chunks of 100
        for (let i = 0; i < trackUris.length; i += 100) {
            const chunk = trackUris.slice(i, i + 100);
            try {
                await spUser.addTracksToPlaylist(playlistId, chunk);
                addedCount += chunk.length;
                console.log(`  Added chunk ${i/100 + 1}, total added: ${addedCount}`);
            } catch (err) {
                const msg = `Failed adding chunk: ${err.message} (Status: ${err.statusCode})`;
                console.error(`  ERROR: ${msg}`);
                errors.push(msg);
            }
        }

        if (errors.length > 0) {
            return { success: false, added_count: addedCount, error: errors.join('; ') };
        }
        return { success: true, added_count: addedCount };
    }

    // --- POST /api/convert Route ---
    router.post('/', extractToken, async (req, res, next) => {
        // 1. Check Authentication via Token
        const userAccessToken = req.token;
        if (!userAccessToken) {
            return res.status(401).json({ error: "Authorization token missing or invalid.", auth_required: true });
        }

        // Create temporary API client for user-specific actions
        const spUser = new SpotifyWebApi({ accessToken: userAccessToken });
        let spotifyUserId = null;
        try {
            // Verify token and get user ID
            const me = await spUser.getMe();
            spotifyUserId = me.body.id;
            console.log(`[CONVERT] Request authenticated for user: ${spotifyUserId}`);
        } catch (err) {
             console.error('[CONVERT] Invalid token during user check:', err.message);
             return res.status(401).json({ error: "Invalid or expired Spotify token.", auth_required: true });
        }

        // 2. Get Request Body Data
        const { playlist_url: youtubePlaylistUrl, playlist_name: spotifyPlaylistName = 'Converted YouTube Playlist' } = req.body;
        if (!youtubePlaylistUrl) {
            return res.status(400).json({ error: "Missing 'playlist_url' in request." });
        }

        let youtubeTracks = [];
        let spotifyTrackUris = [];
        let notFoundTracks = [];
        let resultData = {};

        try {
            // 3. Extract YouTube Playlist ID
            const playlistId = getYoutubePlaylistId(youtubePlaylistUrl);
            if (!playlistId) {
                return res.status(400).json({ error: "Invalid YouTube Music Playlist URL format." });
            }

            // 4. Get YouTube Tracks
            console.log(`Fetching YouTube playlist: ${playlistId}`);
            youtubeTracks = await getYoutubePlaylistItems(playlistId);
            console.log(`Found ${youtubeTracks.length} tracks on YouTube.`);
            if (youtubeTracks.length === 0) {
                 return res.status(404).json({ error: "Could not fetch tracks from YouTube (playlist empty, private, or API issue?)." });
            }

            // 5. Search Spotify Tracks
            console.log("Searching Spotify for tracks...");
            // Use search client if available (no change needed here)
            const spSearch = spotifySearchApi;
            if (!spSearch) {
                 // If search client failed init, maybe try user client? Less ideal.
                 console.warn("Spotify search client not available, falling back to user token for search.");
                 spSearch = spUser; 
                 // Alternatively, return an error if search is critical
                 // return res.status(503).json({ error: "Spotify search service unavailable." });
            }

            // Use Promise.all for potentially faster searching (though limited by API rate limits)
            const searchPromises = youtubeTracks.map(trackData => searchSpotifyTrack(spSearch, trackData));
            const searchResults = await Promise.all(searchPromises);

            searchResults.forEach((uri, index) => {
                if (uri) {
                    spotifyTrackUris.push(uri);
                } else {
                    notFoundTracks.push(youtubeTracks[index].title);
                }
            });

            console.log(`Found ${spotifyTrackUris.length} matching tracks on Spotify.`);
            if (spotifyTrackUris.length === 0) {
                 resultData = {
                     total_youtube_tracks: youtubeTracks.length,
                     found_spotify_tracks: 0,
                     not_found_tracks: notFoundTracks,
                 };
                return res.status(404).json({
                    error: "Could not find any matching tracks on Spotify for this playlist.",
                    data: resultData
                });
            }

            // 6. Create Spotify Playlist - Pass access token
            console.log(`Creating Spotify playlist '${spotifyPlaylistName}'...`);
            const spotifyPlaylistUri = await createSpotifyPlaylist(userAccessToken, spotifyUserId, spotifyPlaylistName);
            const spotifyPlaylistIdOnly = spotifyPlaylistUri.split(':')[2];
            const spotifyPlaylistUrl = `https://open.spotify.com/playlist/${spotifyPlaylistIdOnly}`;
            console.log(`Created playlist URL: ${spotifyPlaylistUrl}`);

            // 7. Add Tracks to Playlist - Pass access token
            console.log(`Adding ${spotifyTrackUris.length} tracks to playlist...`);
            const addResult = await addTracksToSpotifyPlaylist(userAccessToken, spotifyPlaylistUri, spotifyTrackUris);

            // 8. Prepare Response Data
            resultData = {
                spotify_playlist_id: spotifyPlaylistIdOnly,
                spotify_playlist_name: spotifyPlaylistName,
                spotify_playlist_url: spotifyPlaylistUrl,
                total_youtube_tracks: youtubeTracks.length,
                found_spotify_tracks: spotifyTrackUris.length,
                tracks_added: addResult.added_count,
                not_found_tracks: notFoundTracks,
                api_errors: addResult.success ? [] : [addResult.error]
            };

            return res.status(200).json({ success: true, data: resultData });

        } catch (err) {
            console.error("Error during conversion process:", err.message);
            // Send back partial data if available (e.g., tracks were fetched but playlist creation failed)
            const partialData = {
                total_youtube_tracks: youtubeTracks?.length || null,
                found_spotify_tracks: spotifyTrackUris?.length || null,
                not_found_tracks: notFoundTracks?.length ? notFoundTracks : null,
                api_errors: [err.message]
            };
            // Determine appropriate status code based on error source if possible
            const statusCode = err.message.includes("YouTube") ? 502 : (err.message.includes("Spotify") ? 502 : 500);
            // Send partial data only on server/API errors
            return res.status(statusCode).json({ 
                error: err.message, 
                data: (statusCode === 502 || statusCode === 500) ? partialData : undefined 
            }); 
            // Or just pass to generic error handler: next(err);
        }
    });

    return router; // Return the configured router
}; 