# Rushi Mail — GitHub Pages edition

A temporary inbox website with a separate free Cloudflare Worker for email access.

1. Upload this folder’s contents to your public repository, with `index.html` at the root.
2. Enable Settings → Pages → Deploy from a branch → main → / (root).
3. Import the same repository into Cloudflare Workers; set root directory to `backend`, leave build command empty, and use deploy command `npx wrangler deploy`.
4. Open the GitHub Pages website, select Email setup and paste your deployed Worker’s `workers.dev` address.

Read [setup.html](./setup.html) or [START-HERE.txt](./START-HERE.txt) for every step, a copy-paste alternative and optional free DropMail domains.

The Worker allows `https://unsungstories-2626.github.io` by default. See the guide for changing `ALLOWED_ORIGIN`. No private tokens are included in this repository. Receiving email requires the Worker; GitHub Pages alone cannot run it. No outgoing email or universal OTP acceptance is provided.
