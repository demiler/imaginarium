const WebSocket = require('ws');
const uuid = require('uuid');
const { mmdt } = require('./send');
const { log } = require('./logger.js');
const { Player }  = require('../src/js/player.js');
const { getName } = require('../src/js/utils/names.js');
const { getColor } = require('../src/js/utils/colors.js');
const { cardsDB } = require('./cards-db.js');

//============================LOGS==============================//
log.setLog('spipo', false);
log.setLog('serror', true);
log.setLog('sclient', true);
log.setLog('shandler', false);
//===========================CONFIG=============================//
const server = new WebSocket.Server({
  port: 8081,
});

let clientBase = new Map();
let lostClients = new Map();
let appState = 'lobby';

//==========================HANDLERS============================//
server.handlers = new Map();
server.handleRequest = (ws, data) => {
  const type = data.split(' ')[0]; 
  const msg = data.substr(type.length + 1);
  const handler = server.handlers.get(type);
  log.do('shandler', `Received handler '${type}' with '${msg}'`);

  if (handler) handler(ws, msg);
  else log.do('serror', `handler '${type}' not found`);
}

server.handlers.set('connected', (ws, id) => handleClient(ws, id));

server.handlers.set('IWantNewColor', (ws) => {
  ws.data.player.color = getColor();
  server.sendAll('colorUpdate', { id: ws.data.player.id, color: ws.data.player.color });
});

//======================CONNECTION SETUP========================//
server.on('connection', ws => {
  ws.isAlive = true;    //used for ping-pong
  ws.isActive = false;  //used for detecting same client 

  ws.say = (type, data) => ws.send(JSON.stringify({ type, data }));

  ws.on('message', (data) => {
    if (data.startsWith('server'))
      server.handleRequest(ws, data.substr(7)); //7 = 'server '.length
    else
      server.sendAllButRaw(data, ws)
  });

  ws.on('close', () => {
    if (!ws.isActive) return;
    log.do('sclient', `Connection lost with ${ws.data.player.name}`);
    handleDisconnect(ws);
  });

  ws.on('pong', () => {
    ws.isAlive = true;
    log.do('spipo', 'Cleint pong');
  });
});

//========================PING CLIENT===========================//
server.pinger = setInterval(() => {
  server.clients.forEach(client => {
    if (!client.isActive) return;
    if (!client.isAlive) {
      log.do('spipo', 'Client not respoding');
      handleDisconnect(client);
    }
    client.isAlive = false;
    client.ping()
  });
}, 10000);

//=======================HANDLE CLIENT==========================//
const handleClient = (ws, id) => {
  if (clientBase.has(id) && !lostClients.has(id)) {
    log.do('sclient', 'Same client opened game in another tab');
    ws.say('closeThisTab');
    return;
  }

  let lostClient = lostClients.get(id);
  log.do('sclient',
    `Client id recieved: ${id}. Is client found: ${lostClient !== undefined}`);

  if (lostClient !== undefined) {
    ws.data = lostClient;
    lostClients.delete(id);

    if (ws.data.removed)
      server.sendAllBut('addClient', ws.data.player, ws);
    else if (ws.data.player.status === 'offline') {
      ws.data.player.status = ws.data.player.statusBeforeOffline;
      server.sendAllBut('statusUpdate', 
        { id: ws.data.player.id, status: ws.data.player.status }, ws);
    }
    ws.data.removed = false;
    clearTimeout(ws.data.timeouts.offline);
    clearTimeout(ws.data.timeouts.remove);
    clearTimeout(ws.data.timeouts.delete);
    log.do('sclient', `Resurrecting old player. ${ws.data.player.name}`);
  }
  else {
    ws.data = {
      removed: false,
      player: new Player(uuid.v4(), getName(), getColor()),
      cards: cardsDB.getNCards(6),
      timeouts: {},
    };
    server.sendAllBut('addClient', ws.data.player, ws);
    log.do('sclient', `Creating new player ${ws.data.player.id}. ${ws.data.player.name}`);
  }

  ws.isActive = true;
  clientBase.set(ws.data.player.id, ws.data);

  ws.say('setup', {
    players: Array.from(clientBase.values(), client => client.player),
    cards: ws.data.cards,
    id: ws.data.player.id,
    appState,
  });
  log.do('sclient');
}
//=====================HANDLE DISCONNECT========================//
const handleDisconnect = (ws) => {
  lostClients.set(ws.data.player.id, ws.data);

  ws.data.timeouts.offline = setTimeout(() => {
    server.sendAllBut('statusUpdate', { id: ws.data.player.id, status: 'offline' }, ws);
    ws.data.player.statusBeforeOffline = ws.data.player.status;
    ws.data.player.status = 'offline';
    console.log(ws.data.player.statusBeforeOffline);
  }, 400);

  ws.data.timeouts.remove = setTimeout(() => { 
    if (!lostClients.has(ws.data.id)) return;
    ws.data.removed = true;
    server.sendAllBut('removeClient', ws.data.player.id, ws);
    clientBase.delete(ws.data.player.id);
    log.do('sclient', `Sending reuqest to delete client ${ws.data.player.name}`);
  }, 10000);

  ws.data.timeouts.delete = setTimeout(() => { 
    if (!lostClients.delete(ws.data.id)) return;
    log.do('sclient', `${ws.data.player.name} was deleted completly`);
  }, 30000);
}

//==========================SENDERS=============================//
server.sendAllBut = (type, data, ignoreClient) => {
  server.clients.forEach(client => {
    if (client !== ignoreClient && client.isActive) 
      client.say(type, data);
  });
}
server.sendAll = (type, data) => {
  server.clients.forEach(client => {
    if (client.isActive)
      client.say(type, data)
  });
}
server.sendAllButRaw = (data, ignoreClient) => {
  server.clients.forEach(client => {
    if (client !== ignoreClient && client.isActive) 
      client.send(data);
  });
}
