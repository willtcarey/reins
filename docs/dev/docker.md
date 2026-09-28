# Docker

Build and run REINS in a container using the `Dockerfile` at the repo root.

## Build

```sh
docker build -t reins .
```

## Run

```sh
docker run -p 3100:3100 \
  -e ANTHROPIC_API_KEY=your-key \
  -v reins-data:/data \
  reins
```

The image runs `packages/backend/src/supervisor.ts start`, which runs the server and the local node as separate processes (restarting the node if it crashes). The `-v reins-data:/data` mount persists both the server database (`/data/reins.db`) and the local node's canonical session storage (`/data/.reins/node/storage.db`, since the image sets `HOME=/data`). Back up both together. Without the volume, projects, tasks, and sessions are lost when the container stops.

Mount your project directories so REINS (the server for git and file views, the node for agent sessions) can access them:

```sh
docker run -p 3100:3100 \
  -e ANTHROPIC_API_KEY=your-key \
  -v reins-data:/data \
  -v /path/to/your/repos:/repos \
  reins
```

Then open [http://localhost:3100](http://localhost:3100) and add projects using their paths inside the container (e.g. `/repos/my-project`).

### Using other providers

Pass the relevant provider API key, then choose the default model in the app's settings UI:

```sh
docker run -p 3100:3100 \
  -e GEMINI_API_KEY=your-key \
  -v reins-data:/data \
  reins
```

See the main [README](../../README.md#configuration) for all configuration variables.
