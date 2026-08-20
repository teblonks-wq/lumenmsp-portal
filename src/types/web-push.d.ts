// Shim so the Portal compiles before `npm i web-push` has been run (the module is
// required lazily in lib/webpush.ts and its absence is handled at runtime). The real
// package ships its own types which take precedence once installed.
declare module 'web-push';
