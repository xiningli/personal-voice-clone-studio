# Agent notes

See CLAUDE.md for the run commands, ports (backend 8010, app 3010; 8000/3000 belong to
another project) and the API contract. `lib/types.ts` is the contract; change it first,
then the routes and UI. Verify with `npx tsc --noEmit && npx eslint .`. Never commit
anything under data/ or public/audio/.
