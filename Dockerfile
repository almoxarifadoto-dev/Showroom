FROM python:3.9-slim

WORKDIR /app

# Copia e instala as dependências
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copia o restante do código para a raiz do container
COPY . .

# Porta padrão utilizada pelo Render
EXPOSE 7860

# Comando de execução explícito
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
