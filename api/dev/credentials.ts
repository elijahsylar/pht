// Credentials of `npm run dev:fake`, kept apart from the server so tests and
// the frontend's UI check can import them without starting it.
//
// Fixed and printed on purpose: they only ever unlock that throwaway process.
export const DEV_USERNAME = 'demo';
export const DEV_PASSWORD = 'demo-password-not-real';
export const DEV_ANSWER = 'demo answer';
export const DEV_API_TOKEN = 'pht_DEMO-ONLY-not-a-real-token-0000000000000000';

// Signs dev:fake's browser JWTs. The UI check uses it to mint an aged token and
// prove the page picks up a renewal.
export const DEV_JWT_SECRET = 'demo-only-jwt-secret-for-dev-fake';
