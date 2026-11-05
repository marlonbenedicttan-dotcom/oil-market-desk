# The client ships minified, with every comment stripped: the source in this repo is the blueprint,
# and the browser only needs the machine. Built here so a deploy always reflects the current source;
# local development keeps serving public/app.js unchanged.
FROM node:22-alpine AS client
WORKDIR /build
COPY public/app.js public/style.css ./
RUN npx --yes esbuild@0.25.0 app.js --minify --charset=utf8 --legal-comments=none --target=es2020 --outfile=app.min.js \
 && npx --yes esbuild@0.25.0 style.css --minify --charset=utf8 --legal-comments=none --target=es2020 --outfile=style.min.css

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7860
# Zero runtime dependencies — no install step needed.
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
# The minified client replaces the source at the same URL (/app.js, /style.css); the service worker
# and every cached ?v= URL keep working because the path does not change.
COPY --from=client /build/app.min.js ./public/app.min.js
COPY --from=client /build/style.min.css ./public/style.min.css
COPY data ./data
COPY scripts ./scripts
EXPOSE 7860
CMD ["node", "server.js"]
