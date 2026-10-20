/* =====================================================================
   config.js — where the pages find the API. Loaded before api.js on
   every page. Usually left blank:
     - a page opened from a development server on port 5500 (VS Code
       Live Server, or Docker's frontend) uses http://localhost:4000/api;
     - anywhere else, /api on the same site: the production setup in
       DEPLOYMENT.md, where one HTTPS address serves the pages and nginx
       passes /api and /uploads to the Node API.
   Set it only when the API is on another address, e.g.
     window.BONGALINK_API_BASE_URL = "https://api.example.com/api";
   (that address must then be in the API's CORS_ORIGIN, and in the
   pages' Content-Security-Policy: deploy/nginx).
   ===================================================================== */

window.BONGALINK_API_BASE_URL = "";
