FROM node:20-alpine
WORKDIR /app
# O usuário "node" tem UID 1000, que é o que o Hugging Face Spaces usa
COPY --chown=node:node server.js showroom.html catalogo.js ./
USER node
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
