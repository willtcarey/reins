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

The `-v reins-data:/data` mount persists the SQLite database across container restarts. Without it, all projects, tasks, and sessions are lost when the container stops.

Mount your project directories so the server can access them:

```sh
docker run -p 3100:3100 \
  -e ANTHROPIC_API_KEY=your-key \
  -v reins-data:/data \
  -v /path/to/your/repos:/repos \
  reins
```

Then open [http://localhost:3100](http://localhost:3100) and add projects using their paths inside the container (e.g. `/repos/my-project`).

### Using other providers

Pass the relevant API key and set `REINS_PROVIDER` / `REINS_MODEL` together:

```sh
docker run -p 3100:3100 \
  -e GEMINI_API_KEY=your-key \
  -e REINS_PROVIDER=google \
  -e REINS_MODEL=gemini-2.5-pro \
  -v reins-data:/data \
  reins
```

See the main [README](../../README.md#configuration) for all configuration variables.
