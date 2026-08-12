import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database('fleet_v2.db');

const columnExists = (table: string, column: string) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  return cols.some((c) => c.name === column);
};

const safeAddColumn = (table: string, definition: string) => {
  const [columnName] = definition.trim().split(' ');
  if (!columnExists(table, columnName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
};

// Base schema
// NOTE: We keep migrations idempotent so existing databases continue to work.
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    usuario TEXT UNIQUE NOT NULL,
    senha_hash TEXT NOT NULL,
    perfil TEXT CHECK(perfil IN ('admin', 'motorista')) NOT NULL
  );

  CREATE TABLE IF NOT EXISTS veiculos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    placa TEXT UNIQUE NOT NULL,
    modelo TEXT NOT NULL,
    km_atual REAL NOT NULL DEFAULT 0,
    limite_alerta_sem_registro REAL NOT NULL DEFAULT 5,
    bloqueado_sem_registro INTEGER NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1,
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS viagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    motorista_id INTEGER NOT NULL,
    veiculo_id INTEGER,
    nome_da_obra TEXT NOT NULL,
    km_inicial REAL NOT NULL,
    km_final REAL,
    latitude_inicio REAL,
    longitude_inicio REAL,
    total_paradas INTEGER DEFAULT 0,
    total_litros REAL DEFAULT 0,
    status TEXT CHECK(status IN ('Em Andamento', 'Finalizada')) DEFAULT 'Em Andamento',
    data_inicio DATETIME DEFAULT CURRENT_TIMESTAMP,
    data_fim DATETIME,
    FOREIGN KEY (motorista_id) REFERENCES usuarios (id),
    FOREIGN KEY (veiculo_id) REFERENCES veiculos (id)
  );

  CREATE TABLE IF NOT EXISTS paradas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viagem_id INTEGER NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    litros_abastecidos REAL DEFAULT 0,
    motivo_parada TEXT,
    data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (viagem_id) REFERENCES viagens (id)
  );

  CREATE TABLE IF NOT EXISTS alertas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    km_base REAL,
    km_lido REAL,
    severidade TEXT CHECK(severidade IN ('info', 'aviso', 'critico')) DEFAULT 'aviso',
    resolvido INTEGER NOT NULL DEFAULT 0,
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (veiculo_id) REFERENCES veiculos (id)
  );

  CREATE TABLE IF NOT EXISTS leituras_hodometro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER NOT NULL,
    km_lido REAL NOT NULL,
    origem TEXT NOT NULL,
    observacao TEXT,
    usuario_id INTEGER,
    data_leitura DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (veiculo_id) REFERENCES veiculos (id),
    FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
  );

  CREATE TABLE IF NOT EXISTS manutencoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    descricao TEXT,
    km_troca REAL NOT NULL,
    km_proxima_troca REAL NOT NULL,
    alerta_antecedencia_km REAL NOT NULL DEFAULT 500,
    realizada_em DATE DEFAULT CURRENT_DATE,
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (veiculo_id) REFERENCES veiculos (id)
  );

  CREATE TABLE IF NOT EXISTS motorista_veiculos (
    motorista_id INTEGER NOT NULL,
    veiculo_id INTEGER NOT NULL,
    autorizado INTEGER NOT NULL DEFAULT 1,
    data_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (motorista_id, veiculo_id),
    FOREIGN KEY (motorista_id) REFERENCES usuarios (id),
    FOREIGN KEY (veiculo_id) REFERENCES veiculos (id)
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS manutencao_historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manutencao_id INTEGER NOT NULL,
    veiculo_id INTEGER NOT NULL,
    motorista_id INTEGER,
    tipo TEXT NOT NULL,
    descricao TEXT,
    km_realizada REAL NOT NULL,
    km_proxima REAL NOT NULL,
    valor_gasto REAL NOT NULL DEFAULT 0,
    data_realizada DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (manutencao_id) REFERENCES manutencoes (id),
    FOREIGN KEY (veiculo_id) REFERENCES veiculos (id),
    FOREIGN KEY (motorista_id) REFERENCES usuarios (id)
  );
`);

// Lightweight migration for older databases.
safeAddColumn('viagens', 'veiculo_id INTEGER');
safeAddColumn('veiculos', 'bloqueado_sem_registro INTEGER NOT NULL DEFAULT 0');
safeAddColumn('alertas', 'km_base REAL');
safeAddColumn('alertas', 'km_lido REAL');

const createAlert = (
  veiculoId: number,
  tipo: string,
  mensagem: string,
  severidade: 'info' | 'aviso' | 'critico' = 'aviso',
  kmBase?: number | null,
  kmLido?: number | null
) => {
  db.prepare(
    `INSERT INTO alertas (veiculo_id, tipo, mensagem, severidade, km_base, km_lido) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(veiculoId, tipo, mensagem, severidade, kmBase ?? null, kmLido ?? null);
};

const seedUsers = () => {
  const count = db.prepare('SELECT COUNT(*) as count FROM usuarios').get() as any;
  const salt = bcrypt.genSaltSync(10);
  const insert = db.prepare('INSERT INTO usuarios (nome, usuario, senha_hash, perfil) VALUES (?, ?, ?, ?)');

  if (count.count === 0) {
    const adminHash = bcrypt.hashSync('admin123', salt);
    const driverHash = bcrypt.hashSync('moto123', salt);

    insert.run('Administrador', 'admin', adminHash, 'admin');
    insert.run('Motorista Joao', 'motorista', driverHash, 'motorista');
    console.log('Default users created: admin/admin123 and motorista/moto123');
  }

  const gestorExists = db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get('gestor') as any;
  if (!gestorExists) {
    insert.run('Gestor Frota', 'gestor', bcrypt.hashSync('gestor123', salt), 'admin');
    console.log('Default admin created: gestor/gestor123');
  }
};

const seedVehicles = () => {
  const count = db.prepare('SELECT COUNT(*) as count FROM veiculos').get() as any;
  if (count.count === 0) {
    const insert = db.prepare('INSERT INTO veiculos (placa, modelo, km_atual, limite_alerta_sem_registro, ativo) VALUES (?, ?, ?, ?, 1)');
    insert.run('ABC-1234', 'Caminhao Basculante', 12000, 5);
    insert.run('DEF-5678', 'Van de Apoio', 8450, 5);
    console.log('Default vehicles created.');
  }
};

const seedDriverAuthorizations = () => {
  const motoristas = db.prepare("SELECT id FROM usuarios WHERE perfil = 'motorista'").all() as Array<{ id: number }>;
  const veiculos = db.prepare('SELECT id FROM veiculos WHERE ativo = 1').all() as Array<{ id: number }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO motorista_veiculos (motorista_id, veiculo_id, autorizado, data_atualizacao)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
  `);

  for (const motorista of motoristas) {
    for (const veiculo of veiculos) {
      insert.run(motorista.id, veiculo.id);
    }
  }
};

seedUsers();
seedVehicles();
seedDriverAuthorizations();

interface AuthenticatedRequest extends Request {
  authUser?: {
    id: number;
    nome: string;
    usuario: string;
    perfil: 'admin' | 'motorista';
  };
}

const getBearerToken = (req: Request) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
};

const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Sessao obrigatoria. Faca login novamente.' });
  }

  const session = db.prepare(`
    SELECT u.id, u.nome, u.usuario, u.perfil
    FROM sessoes s
    JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token = ?
  `).get(token) as AuthenticatedRequest['authUser'] | undefined;

  if (!session) {
    return res.status(401).json({ success: false, message: 'Sessao invalida. Faca login novamente.' });
  }

  req.authUser = session;
  next();
};

const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  requireAuth(req, res, () => {
    if (req.authUser?.perfil !== 'admin') {
      return res.status(403).json({ success: false, message: 'Acesso permitido apenas para administrador.' });
    }
    next();
  });
};

const requireMotorista = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  requireAuth(req, res, () => {
    if (req.authUser?.perfil !== 'motorista') {
      return res.status(403).json({ success: false, message: 'Acesso permitido apenas para motorista.' });
    }
    next();
  });
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // --- AUTH ROUTES ---
  app.post('/api/login', (req, res) => {
    const { usuario, senha } = req.body;
    const user = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(usuario) as any;

    if (user && bcrypt.compareSync(senha, user.senha_hash)) {
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessoes (token, usuario_id) VALUES (?, ?)').run(token, user.id);
      res.json({
        success: true,
        user: { id: user.id, nome: user.nome, usuario: user.usuario, perfil: user.perfil, token }
      });
    } else {
      res.status(401).json({ success: false, message: 'Usuario ou senha invalidos' });
    }
  });

  app.post('/api/logout', requireAuth, (req: AuthenticatedRequest, res) => {
    const token = getBearerToken(req);
    if (token) db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
    res.json({ success: true });
  });

  // --- SHARED VEHICLE DATA ---
  app.get('/api/veiculos/ativos', requireAdmin, (req, res) => {
    try {
      const veiculos = db.prepare(`
        SELECT
          v.*,
          (
            SELECT COUNT(*) FROM alertas a
            WHERE a.veiculo_id = v.id AND a.resolvido = 0
          ) as alertas_abertos,
          (
            SELECT COUNT(*) FROM manutencoes m
            WHERE m.veiculo_id = v.id AND v.km_atual >= m.km_proxima_troca
          ) as manutencoes_vencidas,
          (
            SELECT COUNT(*) FROM manutencoes m
            WHERE m.veiculo_id = v.id
              AND v.km_atual < m.km_proxima_troca
              AND v.km_atual >= (m.km_proxima_troca - m.alerta_antecedencia_km)
          ) as manutencoes_proximas
        FROM veiculos v
        WHERE v.ativo = 1
        ORDER BY v.placa
      `).all();

      res.json({ success: true, veiculos });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao buscar veiculos' });
    }
  });

  // --- MOTORISTA ROUTES ---
  app.use('/api/motorista', requireMotorista);

  app.get('/api/motorista/veiculos-autorizados/:id', (req, res) => {
    try {
      const motoristaId = Number(req.params.id);
      if ((req as AuthenticatedRequest).authUser?.id !== motoristaId) {
        return res.status(403).json({ success: false, message: 'Motorista so pode ver seus proprios dados.' });
      }
      const veiculos = db.prepare(`
        SELECT
          v.*,
          (
            SELECT COUNT(*) FROM alertas a
            WHERE a.veiculo_id = v.id AND a.resolvido = 0
          ) as alertas_abertos,
          (
            SELECT COUNT(*) FROM manutencoes m
            WHERE m.veiculo_id = v.id AND v.km_atual >= m.km_proxima_troca
          ) as manutencoes_vencidas,
          (
            SELECT COUNT(*) FROM manutencoes m
            WHERE m.veiculo_id = v.id
              AND v.km_atual < m.km_proxima_troca
              AND v.km_atual >= (m.km_proxima_troca - m.alerta_antecedencia_km)
          ) as manutencoes_proximas
        FROM motorista_veiculos mv
        JOIN veiculos v ON v.id = mv.veiculo_id
        WHERE mv.motorista_id = ? AND mv.autorizado = 1 AND v.ativo = 1
        ORDER BY v.placa
      `).all(motoristaId);

      res.json({ success: true, veiculos });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao buscar veiculos autorizados' });
    }
  });

  app.get('/api/motorista/viagem-ativa/:id', (req, res) => {
    try {
      if ((req as AuthenticatedRequest).authUser?.id !== Number(req.params.id)) {
        return res.status(403).json({ success: false, message: 'Motorista so pode ver sua propria viagem.' });
      }
      const trip = db.prepare(`
        SELECT v.*, ve.placa, ve.modelo
        FROM viagens v
        LEFT JOIN veiculos ve ON ve.id = v.veiculo_id
        WHERE v.motorista_id = ? AND v.status = 'Em Andamento'
      `).get(req.params.id) as any;

      res.json({ success: true, trip: trip || null });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao buscar viagem ativa' });
    }
  });

  app.get('/api/motorista/manutencoes/:id', (req, res) => {
    try {
      const motoristaId = Number(req.params.id);
      if ((req as AuthenticatedRequest).authUser?.id !== motoristaId) {
        return res.status(403).json({ success: false, message: 'Motorista so pode ver suas proprias manutencoes.' });
      }
      const manutencoes = db.prepare(`
        SELECT
          m.*,
          v.placa,
          v.modelo,
          v.km_atual,
          CASE
            WHEN v.km_atual >= m.km_proxima_troca THEN 'VENCIDA'
            WHEN v.km_atual >= (m.km_proxima_troca - m.alerta_antecedencia_km) THEN 'PROXIMA'
            ELSE 'EM_DIA'
          END as status
        FROM manutencoes m
        JOIN veiculos v ON v.id = m.veiculo_id
        JOIN motorista_veiculos mv ON mv.veiculo_id = v.id
        WHERE mv.motorista_id = ? AND mv.autorizado = 1 AND v.ativo = 1
          AND (
            v.km_atual >= m.km_proxima_troca
            OR v.km_atual >= (m.km_proxima_troca - m.alerta_antecedencia_km)
          )
        ORDER BY
          CASE
            WHEN v.km_atual >= m.km_proxima_troca THEN 0
            WHEN v.km_atual >= (m.km_proxima_troca - m.alerta_antecedencia_km) THEN 1
            ELSE 2
          END,
          m.km_proxima_troca ASC
      `).all(motoristaId);

      res.json({ success: true, manutencoes });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao buscar manutencoes do motorista' });
    }
  });

  app.post('/api/motorista/manutencoes/realizar', (req, res) => {
    const { manutencao_id, motorista_id, km_realizada, km_proxima, valor_gasto, descricao } = req.body;
    if (!manutencao_id || !motorista_id || typeof km_realizada !== 'number' || typeof km_proxima !== 'number') {
      return res.status(400).json({ success: false, message: 'Dados invalidos para registrar manutencao.' });
    }
    if (km_proxima <= km_realizada) {
      return res.status(400).json({ success: false, message: 'KM da proxima troca deve ser maior que o KM realizado.' });
    }

    try {
      if ((req as AuthenticatedRequest).authUser?.id !== Number(motorista_id)) {
        return res.status(403).json({ success: false, message: 'Motorista so pode registrar suas proprias manutencoes.' });
      }
      const manut = db.prepare('SELECT * FROM manutencoes WHERE id = ?').get(manutencao_id) as any;
      if (!manut) {
        return res.status(404).json({ success: false, message: 'Manutencao nao encontrada.' });
      }

      const auth = db.prepare('SELECT autorizado FROM motorista_veiculos WHERE motorista_id = ? AND veiculo_id = ?')
        .get(motorista_id, manut.veiculo_id) as any;
      if (!auth || auth.autorizado !== 1) {
        return res.status(403).json({ success: false, message: 'Motorista nao autorizado para este veiculo.' });
      }

      const valorNum = Number(valor_gasto);
      const valorSeguro = Number.isFinite(valorNum) ? valorNum : 0;

      db.prepare(`
        INSERT INTO manutencao_historico
          (manutencao_id, veiculo_id, motorista_id, tipo, descricao, km_realizada, km_proxima, valor_gasto)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        manut.id,
        manut.veiculo_id,
        motorista_id,
        manut.tipo,
        descricao || manut.descricao || null,
        km_realizada,
        km_proxima,
        valorSeguro
      );

      db.prepare(`
        UPDATE manutencoes
        SET km_troca = ?, km_proxima_troca = ?, descricao = ?, realizada_em = CURRENT_DATE
        WHERE id = ?
      `).run(km_realizada, km_proxima, descricao || manut.descricao || null, manut.id);

      db.prepare('UPDATE veiculos SET km_atual = CASE WHEN km_atual > ? THEN km_atual ELSE ? END WHERE id = ?')
        .run(km_realizada, km_realizada, manut.veiculo_id);

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao registrar manutencao realizada' });
    }
  });

  app.post('/api/motorista/iniciar', (req, res) => {
    const { motorista_id, veiculo_id, nome_da_obra, km_inicial, latitude, longitude } = req.body;
    try {
      if ((req as AuthenticatedRequest).authUser?.id !== Number(motorista_id)) {
        return res.status(403).json({ success: false, message: 'Motorista so pode iniciar viagem para si mesmo.' });
      }
      if (latitude === 0 || longitude === 0 || latitude == null || longitude == null) {
        return res.status(400).json({
          success: false,
          message: 'GPS obrigatorio para iniciar viagem. Ative a localizacao e tente novamente.'
        });
      }

      if (!veiculo_id) {
        return res.status(400).json({ success: false, message: 'Selecione um veiculo para iniciar a viagem' });
      }

      const veiculo = db.prepare('SELECT * FROM veiculos WHERE id = ? AND ativo = 1').get(veiculo_id) as any;
      if (!veiculo) {
        return res.status(404).json({ success: false, message: 'Veiculo nao encontrado' });
      }
      if (veiculo.bloqueado_sem_registro === 1) {
        return res.status(403).json({
          success: false,
          message: 'Este veiculo esta bloqueado por uso sem registro. Aguarde liberacao do admin.'
        });
      }
      if (typeof km_inicial !== 'number' || Number.isNaN(km_inicial)) {
        return res.status(400).json({ success: false, message: 'KM inicial invalido.' });
      }
      if (km_inicial < veiculo.km_atual) {
        return res.status(400).json({
          success: false,
          message: `KM inicial (${km_inicial}) menor que o KM atual do veiculo (${veiculo.km_atual}).`
        });
      }
      const saltoSemRegistro = km_inicial - veiculo.km_atual;
      if (saltoSemRegistro >= veiculo.limite_alerta_sem_registro) {
        db.prepare('UPDATE veiculos SET bloqueado_sem_registro = 1 WHERE id = ?').run(veiculo_id);
        createAlert(
          veiculo_id,
          'uso_sem_registro',
          `Tentativa de iniciar viagem com salto de ${saltoSemRegistro.toFixed(1)} km sem registro previo.`,
          saltoSemRegistro >= veiculo.limite_alerta_sem_registro * 4 ? 'critico' : 'aviso',
          veiculo.km_atual,
          km_inicial
        );
        return res.status(403).json({
          success: false,
          message: 'Veiculo bloqueado: KM com salto sem registro. O admin precisa liberar.'
        });
      }

      const autorizacao = db.prepare(`
        SELECT autorizado
        FROM motorista_veiculos
        WHERE motorista_id = ? AND veiculo_id = ?
      `).get(motorista_id, veiculo_id) as any;

      if (!autorizacao || autorizacao.autorizado !== 1) {
        const motorista = db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(motorista_id) as any;
        createAlert(
          veiculo_id,
          'motorista_nao_autorizado',
          `Tentativa de uso por motorista nao autorizado: ${motorista?.nome || `ID ${motorista_id}`}.`,
          'critico'
        );
        return res.status(403).json({ success: false, message: 'Voce nao esta autorizado para este veiculo. O admin ja foi alertado.' });
      }

      const activeForVehicle = db.prepare("SELECT id FROM viagens WHERE veiculo_id = ? AND status = 'Em Andamento'").get(veiculo_id) as any;
      if (activeForVehicle) {
        return res.status(400).json({ success: false, message: 'Este veiculo ja possui uma viagem em andamento' });
      }

      const stmt = db.prepare('INSERT INTO viagens (motorista_id, veiculo_id, nome_da_obra, km_inicial, latitude_inicio, longitude_inicio) VALUES (?, ?, ?, ?, ?, ?)');
      const info = stmt.run(motorista_id, veiculo_id, nome_da_obra, km_inicial, latitude, longitude);

      db.prepare('UPDATE veiculos SET km_atual = CASE WHEN km_atual > ? THEN km_atual ELSE ? END WHERE id = ?')
        .run(km_inicial, km_inicial, veiculo_id);

      db.prepare('INSERT INTO leituras_hodometro (veiculo_id, km_lido, origem, usuario_id, observacao) VALUES (?, ?, ?, ?, ?)')
        .run(veiculo_id, km_inicial, 'inicio_viagem', motorista_id, `Inicio viagem #${info.lastInsertRowid}`);

      const unresolvedCritical = db.prepare(`
        SELECT COUNT(*) as total
        FROM alertas
        WHERE veiculo_id = ? AND resolvido = 0 AND severidade = 'critico'
      `).get(veiculo_id) as any;

      res.json({
        success: true,
        tripId: info.lastInsertRowid,
        warning: unresolvedCritical.total > 0 ? 'Atencao: este veiculo possui alerta critico em aberto.' : null
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao iniciar viagem' });
    }
  });

  app.post('/api/motorista/parada', (req, res) => {
    const { viagem_id, latitude, longitude, litros_abastecidos, motivo_parada } = req.body;

    if (!viagem_id || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: 'Dados incompletos para registro de parada' });
    }

    try {
      const trip = db.prepare('SELECT motorista_id FROM viagens WHERE id = ?').get(viagem_id) as any;
      if (!trip) {
        return res.status(404).json({ success: false, message: 'Viagem nao encontrada' });
      }
      if ((req as AuthenticatedRequest).authUser?.id !== Number(trip.motorista_id)) {
        return res.status(403).json({ success: false, message: 'Motorista so pode registrar parada na propria viagem.' });
      }
      const stmt = db.prepare('INSERT INTO paradas (viagem_id, latitude, longitude, litros_abastecidos, motivo_parada) VALUES (?, ?, ?, ?, ?)');
      stmt.run(viagem_id, latitude, longitude, litros_abastecidos || 0, motivo_parada);
      res.json({ success: true });
    } catch (err) {
      console.error('Erro ao inserir parada no banco:', err);
      res.status(500).json({ success: false, message: 'Erro ao registrar parada no banco de dados' });
    }
  });

  app.post('/api/motorista/finalizar', (req, res) => {
    const { viagem_id, km_final } = req.body;
    try {
      const trip = db.prepare('SELECT * FROM viagens WHERE id = ?').get(viagem_id) as any;
      if (!trip) {
        return res.status(404).json({ success: false, message: 'Viagem nao encontrada' });
      }
      if ((req as AuthenticatedRequest).authUser?.id !== Number(trip.motorista_id)) {
        return res.status(403).json({ success: false, message: 'Motorista so pode finalizar sua propria viagem.' });
      }

      if (km_final < trip.km_inicial) {
        return res.status(400).json({ success: false, message: 'KM final nao pode ser menor que KM inicial' });
      }

      const stats = db.prepare('SELECT COUNT(*) as count, SUM(litros_abastecidos) as total_litros FROM paradas WHERE viagem_id = ?').get(viagem_id) as any;

      db.prepare(`
        UPDATE viagens
        SET km_final = ?,
            total_paradas = ?,
            total_litros = ?,
            status = 'Finalizada',
            data_fim = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(km_final, stats.count, stats.total_litros || 0, viagem_id);

      if (trip.veiculo_id) {
        db.prepare('UPDATE veiculos SET km_atual = CASE WHEN km_atual > ? THEN km_atual ELSE ? END WHERE id = ?')
          .run(km_final, km_final, trip.veiculo_id);

        db.prepare('INSERT INTO leituras_hodometro (veiculo_id, km_lido, origem, usuario_id, observacao) VALUES (?, ?, ?, ?, ?)')
          .run(trip.veiculo_id, km_final, 'fim_viagem', trip.motorista_id, `Fim viagem #${viagem_id}`);
      }

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao finalizar viagem' });
    }
  });

  // --- ADMIN ROUTES ---
  app.use('/api/admin', requireAdmin);

  app.get('/api/admin/relatorios', (req, res) => {
    try {
      const totals = db.prepare(`
        SELECT
          SUM(km_final - km_inicial) as total_km,
          SUM(total_litros) as total_litros
        FROM viagens
        WHERE status = 'Finalizada'
          AND strftime('%Y-%m', data_inicio) = strftime('%Y-%m', 'now')
      `).get() as any;

      const driverStats = db.prepare(`
        SELECT
          u.nome as motorista_nome,
          SUM(v.km_final - v.km_inicial) as total_km,
          SUM(v.total_litros) as total_litros
        FROM viagens v
        JOIN usuarios u ON v.motorista_id = u.id
        WHERE v.status = 'Finalizada'
          AND strftime('%Y-%m', v.data_inicio) = strftime('%Y-%m', 'now')
        GROUP BY v.motorista_id
      `).all() as any[];

      const processedStats = driverStats
        .map((stat) => ({
          ...stat,
          kmL: stat.total_litros > 0 ? stat.total_km / stat.total_litros : 0
        }))
        .sort((a, b) => a.kmL - b.kmL);

      const alertsSummary = db.prepare(`
        SELECT
          SUM(CASE WHEN resolvido = 0 THEN 1 ELSE 0 END) as abertos,
          SUM(CASE WHEN resolvido = 0 AND severidade = 'critico' THEN 1 ELSE 0 END) as criticos
        FROM alertas
      `).get() as any;

      const maintenanceSummary = db.prepare(`
        SELECT
          SUM(CASE WHEN v.km_atual >= m.km_proxima_troca THEN 1 ELSE 0 END) as vencidas,
          SUM(CASE WHEN v.km_atual < m.km_proxima_troca AND v.km_atual >= (m.km_proxima_troca - m.alerta_antecedencia_km) THEN 1 ELSE 0 END) as proximas
        FROM manutencoes m
        JOIN veiculos v ON v.id = m.veiculo_id
      `).get() as any;

      const maintenanceFinance = db.prepare(`
        SELECT
          SUM(valor_gasto) as total_valor,
          COUNT(*) as total_servicos
        FROM manutencao_historico
        WHERE strftime('%Y-%m', data_realizada) = strftime('%Y-%m', 'now')
      `).get() as any;

      const maintenanceFinanceAll = db.prepare(`
        SELECT
          SUM(valor_gasto) as total_valor,
          COUNT(*) as total_servicos
        FROM manutencao_historico
      `).get() as any;

      const maintenanceByType = db.prepare(`
        SELECT
          tipo,
          SUM(valor_gasto) as total_valor,
          COUNT(*) as total_servicos
        FROM manutencao_historico
        WHERE strftime('%Y-%m', data_realizada) = strftime('%Y-%m', 'now')
        GROUP BY tipo
        ORDER BY total_valor DESC
      `).all() as any[];

      res.json({
        success: true,
        totals: {
          totalKm: totals.total_km || 0,
          totalLitros: totals.total_litros || 0,
          gastoEstimado: (totals.total_litros || 0) * 5.5,
          manutencaoValor: maintenanceFinance.total_valor || 0,
          manutencaoServicos: maintenanceFinance.total_servicos || 0,
          manutencaoValorTotal: maintenanceFinanceAll.total_valor || 0,
          manutencaoServicosTotal: maintenanceFinanceAll.total_servicos || 0,
          alertasAbertos: alertsSummary.abertos || 0,
          alertasCriticos: alertsSummary.criticos || 0,
          manutencoesVencidas: maintenanceSummary.vencidas || 0,
          manutencoesProximas: maintenanceSummary.proximas || 0
        },
        driverStats: processedStats,
        maintenanceByType
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao gerar relatorios' });
    }
  });

  app.get('/api/admin/viagens', (req, res) => {
    try {
      const trips = db.prepare(`
        SELECT v.*, u.nome as motorista_nome, ve.placa, ve.modelo
        FROM viagens v
        JOIN usuarios u ON v.motorista_id = u.id
        LEFT JOIN veiculos ve ON ve.id = v.veiculo_id
        ORDER BY v.data_inicio DESC
      `).all();
      res.json({ success: true, trips });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao buscar viagens' });
    }
  });

  app.get('/api/admin/viagem/:id', (req, res) => {
    try {
      const trip = db.prepare(`
        SELECT v.*, u.nome as motorista_nome, ve.placa, ve.modelo
        FROM viagens v
        JOIN usuarios u ON v.motorista_id = u.id
        LEFT JOIN veiculos ve ON ve.id = v.veiculo_id
        WHERE v.id = ?
      `).get(req.params.id) as any;

      if (!trip) return res.status(404).json({ success: false, message: 'Viagem nao encontrada' });

      const stops = db.prepare('SELECT * FROM paradas WHERE viagem_id = ? ORDER BY data_hora ASC').all(req.params.id);
      res.json({ success: true, trip, stops });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao buscar detalhes da viagem' });
    }
  });

  app.get('/api/admin/alertas', (req, res) => {
    try {
      const onlyOpen = req.query.abertos !== '0';
      const alertas = db.prepare(`
        SELECT a.*, v.placa, v.modelo
        FROM alertas a
        JOIN veiculos v ON v.id = a.veiculo_id
        ${onlyOpen ? 'WHERE a.resolvido = 0' : ''}
        ORDER BY a.resolvido ASC, a.severidade DESC, a.data_criacao DESC
      `).all();

      res.json({ success: true, alertas });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao buscar alertas' });
    }
  });

  app.post('/api/admin/alertas/:id/resolver', (req, res) => {
    try {
      const alerta = db.prepare('SELECT * FROM alertas WHERE id = ?').get(req.params.id) as any;
      if (!alerta) {
        return res.status(404).json({ success: false, message: 'Alerta nao encontrado' });
      }
      db.prepare('UPDATE alertas SET resolvido = 1 WHERE id = ?').run(req.params.id);
      if (alerta.tipo === 'uso_sem_registro') {
        const pendingKms = db.prepare(`
          SELECT MAX(km_lido) as max_km_lido
          FROM alertas
          WHERE veiculo_id = ?
            AND tipo = 'uso_sem_registro'
            AND resolvido = 0
        `).get(alerta.veiculo_id) as any;

        const singleKm = typeof alerta.km_lido === 'number' ? alerta.km_lido : null;
        const pendingMaxKm = typeof pendingKms?.max_km_lido === 'number' ? pendingKms.max_km_lido : null;
        const kmToApply = Math.max(singleKm ?? 0, pendingMaxKm ?? 0);
        if (kmToApply > 0) {
          db.prepare('UPDATE veiculos SET km_atual = CASE WHEN km_atual > ? THEN km_atual ELSE ? END WHERE id = ?')
            .run(kmToApply, kmToApply, alerta.veiculo_id);
        }

        // Admin action should effectively release the vehicle.
        db.prepare(`
          UPDATE alertas
          SET resolvido = 1
          WHERE veiculo_id = ?
            AND tipo = 'uso_sem_registro'
            AND resolvido = 0
        `).run(alerta.veiculo_id);
        db.prepare('UPDATE veiculos SET bloqueado_sem_registro = 0 WHERE id = ?').run(alerta.veiculo_id);
      }
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao resolver alerta' });
    }
  });

  app.get('/api/admin/pessoas', (req, res) => {
    try {
      const pessoas = db.prepare(`
        SELECT id, nome, usuario, perfil
        FROM usuarios
        ORDER BY perfil, nome
      `).all();
      res.json({ success: true, pessoas });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao buscar pessoas' });
    }
  });

  app.post('/api/admin/pessoas', (req, res) => {
    const { nome, usuario, senha, perfil } = req.body;
    if (!nome || !usuario || !senha) {
      return res.status(400).json({ success: false, message: 'Nome, usuario e senha sao obrigatorios.' });
    }
    if (perfil !== 'admin' && perfil !== 'motorista') {
      return res.status(400).json({ success: false, message: 'Perfil invalido.' });
    }

    if (String(senha).length < 4) {
      return res.status(400).json({ success: false, message: 'A senha deve ter ao menos 4 caracteres.' });
    }

    try {
      const exists = db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get(usuario) as any;
      if (exists) {
        return res.status(409).json({ success: false, message: 'Usuario ja existe. Escolha outro login.' });
      }

      const salt = bcrypt.genSaltSync(10);
      const senhaHash = bcrypt.hashSync(senha, salt);
      const insertUser = db.prepare('INSERT INTO usuarios (nome, usuario, senha_hash, perfil) VALUES (?, ?, ?, ?)');
      const info = insertUser.run(String(nome).trim(), String(usuario).trim(), senhaHash, perfil);
      const pessoaId = Number(info.lastInsertRowid);

      if (perfil === 'motorista') {
        const veiculos = db.prepare('SELECT id FROM veiculos WHERE ativo = 1').all() as Array<{ id: number }>;
        const insertAuth = db.prepare(`
          INSERT OR IGNORE INTO motorista_veiculos (motorista_id, veiculo_id, autorizado, data_atualizacao)
          VALUES (?, ?, 1, CURRENT_TIMESTAMP)
        `);
        for (const veiculo of veiculos) {
          insertAuth.run(pessoaId, veiculo.id);
        }
      }

      res.json({ success: true, pessoaId });
    } catch (err: any) {
      if (String(err?.message || '').includes('UNIQUE')) {
        return res.status(409).json({ success: false, message: 'Usuario ja existe. Escolha outro login.' });
      }
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao cadastrar pessoa' });
    }
  });

  app.post('/api/admin/motoristas', (req, res) => {
    req.body.perfil = 'motorista';
    const { nome, usuario, senha } = req.body;
    if (!nome || !usuario || !senha) {
      return res.status(400).json({ success: false, message: 'Nome, usuario e senha sao obrigatorios.' });
    }

    if (String(senha).length < 4) {
      return res.status(400).json({ success: false, message: 'A senha deve ter ao menos 4 caracteres.' });
    }

    try {
      const exists = db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get(usuario) as any;
      if (exists) {
        return res.status(409).json({ success: false, message: 'Usuario ja existe. Escolha outro login.' });
      }

      const salt = bcrypt.genSaltSync(10);
      const senhaHash = bcrypt.hashSync(senha, salt);
      const insertUser = db.prepare('INSERT INTO usuarios (nome, usuario, senha_hash, perfil) VALUES (?, ?, ?, ?)');
      const info = insertUser.run(nome, usuario, senhaHash, 'motorista');
      const motoristaId = Number(info.lastInsertRowid);

      const veiculos = db.prepare('SELECT id FROM veiculos WHERE ativo = 1').all() as Array<{ id: number }>;
      const insertAuth = db.prepare(`
        INSERT OR IGNORE INTO motorista_veiculos (motorista_id, veiculo_id, autorizado, data_atualizacao)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      `);
      for (const veiculo of veiculos) {
        insertAuth.run(motoristaId, veiculo.id);
      }

      res.json({ success: true, motoristaId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao cadastrar motorista' });
    }
  });

  app.post('/api/admin/veiculos', (req, res) => {
    const { placa, modelo, km_atual, limite_alerta_sem_registro } = req.body;
    if (!placa || !modelo) {
      return res.status(400).json({ success: false, message: 'Placa e modelo sao obrigatorios.' });
    }

    const kmAtualNum = typeof km_atual === 'number' ? km_atual : 0;
    const limiteNum = typeof limite_alerta_sem_registro === 'number' ? limite_alerta_sem_registro : 5;
    if (kmAtualNum < 0 || limiteNum < 0) {
      return res.status(400).json({ success: false, message: 'KM e limite nao podem ser negativos.' });
    }

    try {
      const normalizedPlate = String(placa).trim().toUpperCase();
      const insert = db.prepare(`
        INSERT INTO veiculos (placa, modelo, km_atual, limite_alerta_sem_registro, ativo)
        VALUES (?, ?, ?, ?, 1)
      `);
      const info = insert.run(normalizedPlate, String(modelo).trim(), kmAtualNum, limiteNum);
      const veiculoId = Number(info.lastInsertRowid);

      const motoristas = db.prepare("SELECT id FROM usuarios WHERE perfil = 'motorista'").all() as Array<{ id: number }>;
      const insertAuth = db.prepare(`
        INSERT OR IGNORE INTO motorista_veiculos (motorista_id, veiculo_id, autorizado, data_atualizacao)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      `);
      for (const motorista of motoristas) {
        insertAuth.run(motorista.id, veiculoId);
      }

      res.json({ success: true, veiculoId });
    } catch (err: any) {
      if (String(err?.message || '').includes('UNIQUE')) {
        return res.status(409).json({ success: false, message: 'Ja existe veiculo com essa placa.' });
      }
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao cadastrar veiculo' });
    }
  });

  app.get('/api/admin/autorizacoes', (req, res) => {
    try {
      const motoristas = db.prepare(`
        SELECT id, nome, usuario
        FROM usuarios
        WHERE perfil = 'motorista'
        ORDER BY nome
      `).all();

      const veiculos = db.prepare(`
        SELECT id, placa, modelo, ativo
        FROM veiculos
        ORDER BY placa
      `).all();

      const autorizacoes = db.prepare(`
        SELECT motorista_id, veiculo_id, autorizado
        FROM motorista_veiculos
      `).all();

      res.json({ success: true, motoristas, veiculos, autorizacoes });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao buscar autorizacoes' });
    }
  });

  app.post('/api/admin/autorizacoes', (req, res) => {
    const { motorista_id, veiculo_id, autorizado } = req.body;
    if (!motorista_id || !veiculo_id || typeof autorizado !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Dados invalidos para autorizacao' });
    }

    try {
      db.prepare(`
        INSERT INTO motorista_veiculos (motorista_id, veiculo_id, autorizado, data_atualizacao)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(motorista_id, veiculo_id)
        DO UPDATE SET
          autorizado = excluded.autorizado,
          data_atualizacao = CURRENT_TIMESTAMP
      `).run(motorista_id, veiculo_id, autorizado ? 1 : 0);

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao salvar autorizacao' });
    }
  });

  app.post('/api/admin/veiculo/:id/leitura', (req, res) => {
    const veiculoId = Number(req.params.id);
    const { km_lido, observacao, usuario_id } = req.body;

    if (typeof km_lido !== 'number' || Number.isNaN(km_lido)) {
      return res.status(400).json({ success: false, message: 'Informe um KM valido para a leitura' });
    }

    try {
      const veiculo = db.prepare('SELECT * FROM veiculos WHERE id = ?').get(veiculoId) as any;
      if (!veiculo) {
        return res.status(404).json({ success: false, message: 'Veiculo nao encontrado' });
      }

      if (km_lido < veiculo.km_atual) {
        createAlert(
          veiculoId,
          'leitura_inconsistente',
          `Leitura de ${km_lido.toFixed(1)} km menor que o KM atual (${veiculo.km_atual.toFixed(1)} km).`,
          'aviso'
        );
      }

      const delta = km_lido - veiculo.km_atual;
      if (delta >= veiculo.limite_alerta_sem_registro) {
        db.prepare('UPDATE veiculos SET bloqueado_sem_registro = 1 WHERE id = ?').run(veiculoId);
        createAlert(
          veiculoId,
          'uso_sem_registro',
          `Possivel uso sem registro: +${delta.toFixed(1)} km sem viagem cadastrada.`,
          delta >= veiculo.limite_alerta_sem_registro * 4 ? 'critico' : 'aviso',
          veiculo.km_atual,
          km_lido
        );
      } else {
        db.prepare('UPDATE veiculos SET km_atual = ? WHERE id = ?').run(km_lido, veiculoId);
      }
      db.prepare('INSERT INTO leituras_hodometro (veiculo_id, km_lido, origem, observacao, usuario_id) VALUES (?, ?, ?, ?, ?)')
        .run(veiculoId, km_lido, 'vistoria', observacao || null, usuario_id || null);

      res.json({ success: true, generatedDelta: delta > 0 ? delta : 0 });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao registrar leitura de painel' });
    }
  });

  app.get('/api/admin/manutencoes', (req, res) => {
    try {
      const manutencoes = db.prepare(`
        SELECT
          m.*,
          v.placa,
          v.modelo,
          v.km_atual,
          CASE
            WHEN v.km_atual >= m.km_proxima_troca THEN 'VENCIDA'
            WHEN v.km_atual >= (m.km_proxima_troca - m.alerta_antecedencia_km) THEN 'PROXIMA'
            ELSE 'EM_DIA'
          END as status
        FROM manutencoes m
        JOIN veiculos v ON v.id = m.veiculo_id
        ORDER BY
          CASE
            WHEN v.km_atual >= m.km_proxima_troca THEN 0
            WHEN v.km_atual >= (m.km_proxima_troca - m.alerta_antecedencia_km) THEN 1
            ELSE 2
          END,
          m.km_proxima_troca ASC
      `).all();

      res.json({ success: true, manutencoes });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao buscar manutencoes' });
    }
  });

  app.post('/api/admin/manutencoes', (req, res) => {
    const { veiculo_id, tipo, descricao, km_troca, km_proxima_troca, alerta_antecedencia_km } = req.body;

    if (!veiculo_id || !tipo || typeof km_troca !== 'number' || typeof km_proxima_troca !== 'number') {
      return res.status(400).json({ success: false, message: 'Dados invalidos para manutencao' });
    }

    if (km_proxima_troca <= km_troca) {
      return res.status(400).json({ success: false, message: 'A proxima troca deve ser maior que o KM da troca atual' });
    }

    try {
      db.prepare(`
        INSERT INTO manutencoes (veiculo_id, tipo, descricao, km_troca, km_proxima_troca, alerta_antecedencia_km)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        veiculo_id,
        tipo,
        descricao || null,
        km_troca,
        km_proxima_troca,
        typeof alerta_antecedencia_km === 'number' ? alerta_antecedencia_km : 500
      );

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Erro ao cadastrar manutencao' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
