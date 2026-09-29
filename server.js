// Servidor do Showroom — sem dependências, só Node.js.
// Guarda tudo em dados.json (mesma pasta). Vários PCs podem usar ao mesmo tempo.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PASTA = __dirname;
// Onde guardar dados.json: DATA_DIR, ou /data (disco persistente do Hugging Face, se existir), ou a pasta do app
const DIR_DADOS = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : PASTA);
const ARQ_DADOS = path.join(DIR_DADOS, 'dados.json');

// Backup opcional num Dataset do Hugging Face (o disco grátis do Space é apagado ao reiniciar)
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_DATASET = process.env.HF_DATASET || ''; // ex: meuusuario/showroom-dados
const HF_ENDPOINT = process.env.HF_ENDPOINT || 'https://huggingface.co';
const HF_DEBOUNCE_MS = Number(process.env.HF_DEBOUNCE_MS) || 5000;
const HF_ATIVO = !!(HF_TOKEN && HF_DATASET);

// Senha opcional (usuário: qualquer um; senha: valor de SENHA)
const SENHA = process.env.SENHA || '';
const ARQ_CATALOGO = path.join(PASTA, 'catalogo.js');
const ARQ_HTML = path.join(PASTA, 'showroom.html');

// ---------- Catálogo base (vem do catalogo.js) ----------
const base = new Function(fs.readFileSync(ARQ_CATALOGO, 'utf8') + '\n;return CATALOGO;')();

// ---------- Dados persistidos ----------
// extras: itens cadastrados por vocês | showroom: { produto: { quantidade, ts } }
let dados = { extras: [], showroom: {} };
let versao = Date.now(); // sobe a cada alteração; clientes usam pra saber se precisam recarregar

const porProduto = new Map();
const porBarras = new Map(); // barras -> [itens]

function indexar(item) {
  porProduto.set(item.produto, item);
  if (item.codigo_barras) {
    const lista = porBarras.get(item.codigo_barras) || [];
    lista.push(item);
    porBarras.set(item.codigo_barras, lista);
  }
}

function carregarDados() {
  if (fs.existsSync(ARQ_DADOS)) {
    try {
      const lido = JSON.parse(fs.readFileSync(ARQ_DADOS, 'utf8'));
      dados.extras = Array.isArray(lido.extras) ? lido.extras : [];
      dados.showroom = lido.showroom && typeof lido.showroom === 'object' ? lido.showroom : {};
    } catch (e) {
      console.error('ERRO: dados.json está corrompido. Não vou sobrescrever.');
      console.error('Existe uma cópia anterior em dados.json.bak — renomeie-a para dados.json se precisar.');
      process.exit(1);
    }
  }
  base.forEach(indexar);
  dados.extras.forEach(indexar);
}

function salvar() {
  versao++;
  const tmp = ARQ_DADOS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dados));
  if (fs.existsSync(ARQ_DADOS)) fs.copyFileSync(ARQ_DADOS, ARQ_DADOS + '.bak');
  fs.renameSync(tmp, ARQ_DADOS);
  agendarBackupHF();
}

// ---------- Backup no Hugging Face (Dataset) ----------
let hfTimer = null;
let hfEnviando = false;
let hfPendente = false;

async function restaurarDoHF() {
  if (!HF_ATIVO || fs.existsSync(ARQ_DADOS)) return;
  try {
    const r = await fetch(`${HF_ENDPOINT}/datasets/${HF_DATASET}/resolve/main/dados.json`, {
      headers: { Authorization: `Bearer ${HF_TOKEN}` }
    });
    if (r.status === 404) { console.log('[HF] Nenhum backup ainda no dataset — começando do zero.'); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const texto = await r.text();
    JSON.parse(texto); // valida
    fs.mkdirSync(DIR_DADOS, { recursive: true });
    fs.writeFileSync(ARQ_DADOS, texto);
    console.log('[HF] Dados restaurados do dataset ' + HF_DATASET);
  } catch (e) {
    console.error('[HF] ERRO ao restaurar backup:', e.message);
    console.error('[HF] Abortando para não sobrescrever o backup com dados vazios. Confira HF_TOKEN e HF_DATASET.');
    process.exit(1);
  }
}

function agendarBackupHF() {
  if (!HF_ATIVO) return;
  clearTimeout(hfTimer);
  hfTimer = setTimeout(enviarBackupHF, HF_DEBOUNCE_MS);
}

async function enviarBackupHF() {
  if (!HF_ATIVO) return;
  if (hfEnviando) { hfPendente = true; return; }
  hfEnviando = true;
  try {
    const conteudo = Buffer.from(JSON.stringify(dados)).toString('base64');
    const corpo =
      JSON.stringify({ key: 'header', value: { summary: 'backup ' + new Date().toISOString() } }) + '\n' +
      JSON.stringify({ key: 'file', value: { path: 'dados.json', content: conteudo, encoding: 'base64' } }) + '\n';
    const r = await fetch(`${HF_ENDPOINT}/api/datasets/${HF_DATASET}/commit/main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/x-ndjson' },
      body: corpo
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    console.log('[HF] Backup enviado.');
  } catch (e) {
    console.error('[HF] Falha no backup (tento de novo na próxima alteração):', e.message);
  } finally {
    hfEnviando = false;
    if (hfPendente) { hfPendente = false; agendarBackupHF(); }
  }
}

// ---------- Lógica ----------
function resolver(codigo) {
  const b = porBarras.get(codigo) || [];
  if (b.length > 1) return { status: 'ambiguo', candidatos: b };
  if (b.length === 1) return { status: 'ok', produto: b[0].produto, origem: 'código de barras' };
  if (porProduto.has(codigo)) return { status: 'ok', produto: codigo, origem: 'código de integração (Produto)' };
  return { status: 'nao_encontrado' };
}

function somarUm(produto) {
  const item = porProduto.get(produto);
  if (!item) return null;
  const atual = dados.showroom[produto];
  const quantidade = (atual ? atual.quantidade : 0) + 1;
  dados.showroom[produto] = { quantidade, ts: Date.now() };
  return { produto, nome: item.nome, marca: item.marca, quantidade };
}

function adicionar(codigos) {
  const adicionados = [];
  const problemas = [];
  for (const codigo of codigos) {
    const r = resolver(codigo);
    if (r.status === 'ambiguo') {
      const nomes = r.candidatos.map(c => `${c.produto} - ${c.nome}`).join(' | ');
      problemas.push(`'${codigo}': código de barras cadastrado em mais de um produto (${nomes}) — nada adicionado`);
    } else if (r.status === 'nao_encontrado') {
      problemas.push(`'${codigo}': não encontrado (nem como código de barras, nem como código de integração)`);
    } else {
      const a = somarUm(r.produto);
      adicionados.push({ ...a, origem: r.origem });
    }
  }
  if (adicionados.length) salvar();
  return { adicionados, problemas };
}

function adicionarProduto(produto, origem) {
  const a = somarUm(produto);
  if (!a) return { adicionados: [], problemas: [`'${produto}': não encontrado`] };
  salvar();
  return { adicionados: [{ ...a, origem: origem || 'busca manual' }], problemas: [] };
}

function removerUm(produto) {
  const s = dados.showroom[produto];
  if (s) {
    s.quantidade -= 1;
    if (s.quantidade <= 0) delete dados.showroom[produto];
    salvar();
  }
  return {};
}

function removerTodos(produto) {
  if (dados.showroom[produto]) {
    delete dados.showroom[produto];
    salvar();
  }
  return {};
}

function zerar() {
  dados.showroom = {};
  salvar();
  return {};
}

function cadastrar(itens) {
  const adicionados = [];
  const avisos = [];
  itens.forEach((it, idx) => {
    const linha = idx + 1;
    const produto = String(it.produto || '').trim();
    const nome = String(it.nome || '').trim();
    const marca = String(it.marca || '').trim();
    let barras = String(it.barras || '').trim();

    if (!produto || !nome) {
      avisos.push({ linha, motivo: 'faltando código ou nome' });
      return;
    }
    if (porProduto.has(produto)) {
      avisos.push({ linha, motivo: `código '${produto}' já existe (no banco ou repetido no próprio lote)` });
      return;
    }
    if (barras && porBarras.has(barras)) {
      avisos.push({ linha, motivo: `EAN '${barras}' já está em uso — item '${produto}' cadastrado SEM esse EAN` });
      barras = '';
    }
    const novo = { produto, nome, marca, codigo_original: produto, codigo_barras: barras };
    dados.extras.push(novo);
    indexar(novo);
    adicionados.push({ produto, nome });
  });
  if (adicionados.length) salvar();
  return { adicionados, avisos };
}

function estado() {
  return { versao, extras: dados.extras, showroom: dados.showroom };
}

// ---------- HTTP ----------
function json(res, obj, status = 200) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(corpo);
}

function arquivo(res, caminho, tipo) {
  fs.readFile(caminho, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes = [];
    req.on('data', c => {
      total += c.length;
      if (total > 2 * 1024 * 1024) { reject(new Error('corpo grande demais')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      try { resolve(partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const rotasPost = {
  '/api/adicionar': b => adicionar((Array.isArray(b.codigos) ? b.codigos : []).map(c => String(c).trim()).filter(Boolean)),
  '/api/adicionar-produto': b => adicionarProduto(String(b.produto || ''), b.origem),
  '/api/remover-um': b => removerUm(String(b.produto || '')),
  '/api/remover': b => removerTodos(String(b.produto || '')),
  '/api/zerar': () => zerar(),
  '/api/cadastrar': b => cadastrar(Array.isArray(b.itens) ? b.itens : []),
};

function autorizado(req) {
  if (!SENHA) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const senhaRecebida = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(senhaRecebida).digest();
  const b = crypto.createHash('sha256').update(SENHA).digest();
  return crypto.timingSafeEqual(a, b);
}

const servidor = http.createServer(async (req, res) => {
  if (!autorizado(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Showroom", charset="UTF-8"' });
    return res.end('Senha necessária');
  }
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/showroom.html') return arquivo(res, ARQ_HTML, 'text/html; charset=utf-8');
    if (url.pathname === '/catalogo.js') return arquivo(res, ARQ_CATALOGO, 'application/javascript; charset=utf-8');
    if (url.pathname === '/api/estado') {
      const v = Number(url.searchParams.get('v'));
      return json(res, v === versao ? { mudou: false } : { mudou: true, estado: estado() });
    }
    res.writeHead(404); return res.end('Não encontrado');
  }

  if (req.method === 'POST' && rotasPost[url.pathname]) {
    try {
      const corpo = await lerCorpo(req);
      const resultado = rotasPost[url.pathname](corpo);
      return json(res, { ...resultado, estado: estado() });
    } catch (e) {
      console.error(e);
      return json(res, { erro: e.message }, 400);
    }
  }

  res.writeHead(404); res.end('Não encontrado');
});

async function main() {
  await restaurarDoHF();
  carregarDados();
  servidor.listen(PORT, '0.0.0.0', () => {
    console.log('==============================================');
    console.log(' SHOWROOM rodando. Deixe esta janela ABERTA.');
    console.log('==============================================');
    console.log(` Neste PC:        http://localhost:${PORT}`);
    for (const lista of Object.values(os.networkInterfaces())) {
      for (const i of lista || []) if (i.family === 'IPv4' && !i.internal) console.log(` Em outro PC:     http://${i.address}:${PORT}`);
    }
    console.log(` Dados salvos em: ${ARQ_DADOS}`);
    console.log(` Backup HF: ${HF_ATIVO ? 'ligado (' + HF_DATASET + ')' : 'desligado'} | Senha: ${SENHA ? 'ligada' : 'desligada'}`);
    console.log('');
  });
}

// Ao desligar/reiniciar, tenta enviar o último backup antes de sair
async function encerrar() {
  clearTimeout(hfTimer);
  try { await Promise.race([enviarBackupHF(), new Promise(r => setTimeout(r, 8000))]); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);

main();
