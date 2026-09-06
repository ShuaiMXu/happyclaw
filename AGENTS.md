# HappyClaw Agent Instructions

## Definition of done

- Completing a feature locally is not sufficient. Every completed feature must be deployed to the user's Mac mini and tested in that deployed environment.
- Do not report a feature as complete until the Mac mini deployment succeeds and the relevant production-environment checks pass.
- Preserve the Mac mini's runtime data and configuration, follow [DEPLOYMENT.md](DEPLOYMENT.md), and report separately on local verification and Mac mini verification.
- The owner has explicitly opted out of deployment backups. Do not create SQLite snapshots, full runtime archives, or `.env` backup copies on the Mac mini unless the owner explicitly reverses this policy in a future request.
