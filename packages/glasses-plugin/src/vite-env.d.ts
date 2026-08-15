/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
/** The realtime server, injected from app.json's network whitelist so the URL
 *  the plugin dials and the URL the host permits cannot drift apart. */
declare const __REALTIME_URL__: string;
