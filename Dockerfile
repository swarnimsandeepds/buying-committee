# The Buying Committee: one container with the Node server, the page and the Bruin CLI.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Bruin CLI (the pipeline runs inside the container after every turn)
RUN curl -LsSf https://getbruin.com/install/cli | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
COPY . .

# Bruin looks for the project root through git, so make the app folder a repository.
RUN git init -q . \
 && mkdir -p data \
 && (bruin validate pipeline || echo 'Bruin validation failed at build time; the app will use its local fallback')

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
