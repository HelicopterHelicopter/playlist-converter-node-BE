# Backend Authentication Architecture Update: Token-Based Flow

The backend no longer uses cookie-based sessions. Authentication is now handled by passing tokens directly between the backend and frontend. The frontend is responsible for storing these tokens and sending them with API requests.

**Security Warning:** Storing access tokens and especially refresh tokens in Local Storage makes them vulnerable to theft via Cross-Site Scripting (XSS) attacks. If an attacker can inject JavaScript into your frontend, they can steal these tokens. `HttpOnly` cookies provide better protection against this specific threat.

**1. Authentication Flow Overview**

1.  **Initiate Login:** The frontend redirects the user to the backend's login endpoint: `GET /api/auth/login`.
2.  **Backend Redirects to Spotify:** The backend redirects the user to the Spotify authorization page.
3.  **User Authorizes:** The user logs into Spotify (if necessary) and authorizes the application.
4.  **Spotify Redirects to Backend Callback:** Spotify redirects the user's browser back to the backend's callback endpoint: `GET /callback`.
5.  **Backend Exchanges Code & Redirects to Frontend:** The backend (`/callback`) exchanges the `code` from Spotify for an `access_token`, `refresh_token`, and `expires_in`. It **does not** set a cookie. Instead, it immediately redirects the user's browser back to a _specific_ route on the frontend (e.g., `/auth/callback`), **including the tokens in the URL fragment (`#`)**.
    - Example Redirect URL: `https://convert.jheels.in/auth/callback#access_token=BQD...&refresh_token=AQB...&expires_in=3600`
6.  **Frontend Stores Tokens:** The frontend JavaScript at the `/auth/callback` route reads the tokens from the URL fragment (`window.location.hash`) and stores them securely (e.g., Local Storage, Session Storage - **note the security implications below**).
7.  **Frontend Authenticates API Calls:** For all subsequent requests to protected backend endpoints, the frontend includes the stored `access_token` in the `Authorization` header.
8.  **Frontend Refreshes Token:** The frontend tracks token expiry using `expires_in` and uses the `refresh_token` to request a new `access_token` from the backend when needed.

**2. Frontend Callback Handling (`/auth/callback`)**

- Create a route/page on the frontend (e.g., `/auth/callback`) that the backend redirects to after successful authentication (or errors).
- This page's JavaScript needs to:
  - Parse the URL fragment (`window.location.hash`) using `URLSearchParams`.
  - Check for an `error` parameter first. If present, display an appropriate error message.
  - If no error, extract `access_token`, `refresh_token`, and `expires_in`.
  - Calculate the actual expiry timestamp: `expiryTimestamp = Date.now() + (parseInt(expires_in, 10) * 1000);`
  - Store `access_token`, `refresh_token`, and `expiryTimestamp` securely.
  - Redirect the user to the main part of the application or update the UI state to reflect login.

**3. Token Storage (Frontend)**

- **Local Storage:** Convenient but vulnerable to XSS attacks. If an attacker injects script into your site, they can steal tokens from Local Storage.
- **Session Storage:** Slightly more secure than Local Storage as it's cleared when the browser tab closes, but still vulnerable to XSS during the active session.
- **(Advanced) In Memory:** Storing tokens only in JavaScript memory (e.g., in a state management store like Redux/Zustand/Vuex) is more secure against XSS but requires re-authentication if the page is refreshed or the tab is closed. Refresh tokens should _still_ ideally be stored more persistently but securely if using this method.

**Recommendation:** If using Local/Session storage, be extra vigilant about preventing XSS vulnerabilities on the frontend.

**4. Authenticating API Requests**

- For _every_ request to backend endpoints that require authentication (e.g., `/api/auth/status`, `/api/convert`), the frontend must:

  - Retrieve the currently valid `access_token` from storage.
  - Add an `Authorization` header to the request:

    ```javascript
    // Using fetch
    fetch("https://pl-convert.jheels.in/api/convert", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${your_access_token}`, // <-- Add this
        "Content-Type": "application/json",
        // ... other headers
      },
      body: JSON.stringify({
        /* ... your data ... */
      }),
      // credentials: 'include' IS NO LONGER NEEDED/RELEVANT
    });

    // Using axios
    axios.post(
      "https://pl-convert.jheels.in/api/convert",
      {
        /* ... your data ... */
      },
      {
        headers: {
          Authorization: `Bearer ${your_access_token}`, // <-- Add this
        },
        // withCredentials: true IS NO LONGER NEEDED/RELEVANT
      }
    );
    ```

**5. Token Refresh**

- Before making an authenticated API call, the frontend should check if the stored `access_token` is expired or close to expiring (using the stored `expiryTimestamp`).
- If expired:
  - Make a `POST` request to the backend's ` /api/auth/refresh` endpoint.
  - Send the stored `refresh_token` in the JSON request body: `{ "refresh_token": "your_refresh_token" }`.
  - The backend will respond with a JSON object containing a new `access_token`, `expires_in`, and potentially a new `refresh_token`.
    ```json
    {
      "access_token": "...",
      "expires_in": 3600,
      "refresh_token": "..." // Optional: May be null
    }
    ```
  - Update the stored `access_token`, calculate and store the new `expiryTimestamp`, and store the new `refresh_token` if provided.
  - Retry the original API request with the new `access_token`.
- Handle errors from the `/api/auth/refresh` endpoint (e.g., if the refresh token is invalid/revoked, requiring the user to log in again).

**6. Logout**

- Logout is now handled entirely by the frontend.
- Simply delete the stored `access_token`, `refresh_token`, and `expiryTimestamp` from frontend storage (Local Storage, Session Storage, or memory).
- Update the UI state to reflect that the user is logged out.

**7. Backend Endpoint Summary**

- `GET /api/auth/login`: Initiates the Spotify login flow (frontend redirects browser here).
- `GET /callback`: Handles the redirect back from Spotify, exchanges code for tokens, redirects to frontend `/auth/callback#tokens...` (browser navigates here).
- `GET /api/auth/status`: Checks if the `access_token` provided in the `Authorization: Bearer <token>` header is valid. Returns user info if valid.
- `POST /api/auth/refresh`: Exchanges a `refresh_token` (sent in request body) for a new `access_token`.
- `POST /api/convert`: Converts the playlist. Requires `Authorization: Bearer <token>` header.
