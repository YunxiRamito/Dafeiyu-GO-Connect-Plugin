# DSH Web Broadcast Plugin (offline validation)

Run from this repository with Node.js 26 or newer:

```powershell
node --experimental-strip-types --test tests/broadcast/*.test.mjs
```

The tests use only Node built-ins and an in-memory fake Provider. They do not contact Aries, the launcher, a browser, or the network.
