const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const IS_DEBUG = process.argv.includes('--debug');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
const {
  BOARD,
  CHANCE_CARDS,
  COMMUNITY_CARDS,
  PLAYER_EMOJIS,
  PLAYER_COLORS,
  PLAYER_NAMES,
  STARTING_MONEY
} = require('./config/game_config');
// ─── 房间管理 ────────────────────────────────────────────────────────────────

const rooms = {};

function createRoom(roomCode) {
    return {
        code: roomCode,
        players: [],
        gameStarted: false,
        currentPlayerIndex: 0,
        board: JSON.parse(JSON.stringify(BOARD)),
        properties: {},
        chanceCards: shuffle([...CHANCE_CARDS]),
        communityCards: shuffle([...COMMUNITY_CARDS]),
        log: [],
        phase: 'waiting',
        diceResult: null,
        pendingAction: null,
        debtInfo: null,
    };
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}


// ─── Socket 逻辑 ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

    socket.on('create_room', ({ nickname }) => {
        const code = Math.random().toString(36).substr(2, 6).toUpperCase();
        rooms[code] = createRoom(code);
        joinRoom(socket, code, nickname);
    });

    socket.on('join_room', ({ code, nickname }) => {
        const room = rooms[code.toUpperCase()];
        if (!room) return socket.emit('error', '房间不存在');
        if (room.gameStarted) return socket.emit('error', '游戏已开始');
        if (room.players.length >= 6) return socket.emit('error', '房间已满');
        joinRoom(socket, code.toUpperCase(), nickname);
    });

    socket.on('start_game', ({ code }) => {
        const room = rooms[code];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || room.players.indexOf(player) !== 0) return socket.emit('error', '只有房主可以开始游戏');
        
        const minPlayers = IS_DEBUG ? 1 : 2;
        if (room.players.length < minPlayers) return socket.emit('error', `至少需要${minPlayers}名玩家`);
        
        room.gameStarted = true;
        room.phase = 'rolling';
        addLog(room, '🎮 游戏开始！泰拉大陆的财富争夺战正式打响！');
        io.to(code).emit('game_started', getGameState(room));
    });

    socket.on('roll_dice', ({ code }) => {
        const room = rooms[code];
        if (!room || !room.gameStarted) return;
        const player = getCurrentPlayer(room);
        if (!player || player.id !== socket.id) return;
        if (room.phase !== 'rolling') return;
        if (player.jailTurns > 0) return; // 在监狱中单独处理

        const d1 = Math.ceil(Math.random() * 6);
        const d2 = Math.ceil(Math.random() * 6);
        const total = d1 + d2;
        room.diceResult = { d1, d2, total };

        const oldPos = player.position;
        player.position = (player.position + total) % 40;
        const passedGo = player.position < oldPos && oldPos !== 0;

        if (passedGo && player.position !== 0) {
            player.money += 2000;
            addLog(room, `${player.emoji} ${player.name} 经过罗德岛舰桥，收取 ¥2,000`);
        }

        addLog(room, `${player.emoji} ${player.name} 掷出 ${d1}+${d2}=${total}，移动到【${BOARD[player.position].name}】`);

        room.phase = 'action';
        processLanding(room, player, socket, code);
    });

    socket.on('jail_roll', ({ code }) => {
        const room = rooms[code];
        if (!room) return;
        const player = getCurrentPlayer(room);
        if (!player || player.id !== socket.id || player.jailTurns <= 0) return;

        const d1 = Math.ceil(Math.random() * 6);
        const d2 = Math.ceil(Math.random() * 6);
        room.diceResult = { d1, d2, total: d1 + d2 };

        if (d1 === d2) {
            player.jailTurns = 0;
            addLog(room, `${player.emoji} ${player.name} 掷出双数 ${d1}+${d2}，成功解除隔离！`);
            const oldPos = player.position;
            player.position = (player.position + d1 + d2) % 40;
            if (player.position < oldPos) {
                player.money += 2000;
                addLog(room, `${player.emoji} ${player.name} 经过罗德岛舰桥，收取 ¥2,000`);
            }
            addLog(room, `${player.emoji} ${player.name} 移动到【${BOARD[player.position].name}】`);
            room.phase = 'action';
            processLanding(room, player, socket, code);
        } else {
            player.jailTurns--;
            addLog(room, `${player.emoji} ${player.name} 未掷出双数，继续隔离（剩余 ${player.jailTurns} 回合）`);
            if (player.jailTurns === 0) {
                player.money -= 500;
                addLog(room, `${player.emoji} ${player.name} 支付 ¥500 解除隔离`);
                io.to(code).emit('game_state', getGameState(room));
            }
            nextTurn(room, code);
        }
    });

    socket.on('jail_pay', ({ code }) => {
        const room = rooms[code];
        if (!room) return;
        const player = getCurrentPlayer(room);
        if (!player || player.id !== socket.id || player.jailTurns <= 0) return;
        if (player.money < 500) return socket.emit('error', '资金不足');
        player.money -= 500;
        player.jailTurns = 0;
        addLog(room, `${player.emoji} ${player.name} 支付 ¥500 解除隔离，等待下次掷骰`);
        room.phase = 'rolling';
        io.to(code).emit('game_state', getGameState(room));
    });

    socket.on('buy_property', ({ code }) => {
        const room = rooms[code];
        if (!room) return;
        const player = getCurrentPlayer(room);
        if (!player || player.id !== socket.id) return;
        if (room.phase !== 'action') return;

        const tile = BOARD[player.position];
        if (!['property','port','utility'].includes(tile.type)) return;
        if (room.properties[tile.id]) return;
        if (player.money < tile.price) return socket.emit('error', '资金不足');

        player.money -= tile.price;
        room.properties[tile.id] = { owner: player.id, level: 0, mortgaged: false };
        addLog(room, `${player.emoji} ${player.name} 购买了【${tile.name}】，花费 ¥${tile.price}`);

        nextTurn(room, code);
    });

    socket.on('skip_buy', ({ code }) => {
        const room = rooms[code];
        if (!room) return;
        const player = getCurrentPlayer(room);
        if (!player || player.id !== socket.id) return;
        if (room.phase !== 'action') return;
        addLog(room, `${player.emoji} ${player.name} 放弃购买`);
        nextTurn(room, code);
    });

    socket.on('upgrade_property', ({ code, tileId }) => {
        const room = rooms[code];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const tile = BOARD[tileId];
        if (!tile || tile.type !== 'property') return;
        const prop = room.properties[tileId];
        if (!prop || prop.owner !== socket.id || prop.mortgaged) return;
        if (prop.level >= 5) return socket.emit('error', '已达最高等级');
        if (player.money < tile.upgradeCost) return socket.emit('error', '资金不足');

        player.money -= tile.upgradeCost;
        prop.level++;
        addLog(room, `${player.emoji} ${player.name} 升级【${tile.name}】至 Lv.${prop.level}`);
        io.to(code).emit('game_state', getGameState(room));
    });

    socket.on('mortgage_property', ({ code, tileId }) => {
        const room = rooms[code];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        const tile = BOARD[tileId];
        if (!tile) return;
        const prop = room.properties[tileId];
        if (!prop || prop.owner !== socket.id || prop.mortgaged) return;

        prop.mortgaged = true;
        player.money += tile.mortgage || Math.floor(tile.price / 2);
        addLog(room, `${player.emoji} ${player.name} 抵押了【${tile.name}】，获得 ¥${tile.mortgage || Math.floor(tile.price / 2)}`);

        // 如果在负债阶段且资金已还清，自动解除负债
        if (room.phase === 'debt' && room.debtInfo?.playerId === player.id && player.money >= 0) {
            addLog(room, `✅ ${player.emoji} ${player.name} 成功偿还负债！`);
            room.debtInfo = null;
            nextTurn(room, code);
            return;
        }

        io.to(code).emit('game_state', getGameState(room));
    });

    // 玩家在负债阶段点击"确认偿还" / 放弃挣扎
    socket.on('debt_resolve', ({ code }) => {
        const room = rooms[code];
        if (!room || room.phase !== 'debt') return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || room.debtInfo?.playerId !== player.id) return;

        if (player.money >= 0) {
            // 已偿还成功
            addLog(room, `✅ ${player.emoji} ${player.name} 成功偿还负债！`);
            room.debtInfo = null;
            nextTurn(room, code);
        } else {
            // 仍然为负 → 强制破产
            const creditor = room.debtInfo.creditorId
                ? room.players.find(p => p.id === room.debtInfo.creditorId) : null;
            room.debtInfo = null;
            forceBankrupt(room, player, creditor, code);
            nextTurn(room, code);
        }
    });

    socket.on('chat', ({ code, message }) => {
        const room = rooms[code];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        const msg = `${player.emoji} ${player.name}: ${message.slice(0, 100)}`;
        addLog(room, msg);
        io.to(code).emit('game_state', getGameState(room));
    });

    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                const player = room.players[idx];
                addLog(room, `${player.emoji} ${player.name} 断开连接`);
                player.connected = false;
                if (room.players.every(p => !p.connected)) {
                    delete rooms[code];
                } else {
                    io.to(code).emit('game_state', getGameState(room));
                }
                break;
            }
        }
    });
});

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

function joinRoom(socket, code, nickname) {
    const room = rooms[code];
    const idx = room.players.length;
    const player = {
        id: socket.id,
        name: nickname || PLAYER_NAMES[idx],
        emoji: PLAYER_EMOJIS[idx],
        color: PLAYER_COLORS[idx],
        money: STARTING_MONEY,
        position: 0,
        jailTurns: 0,
        bankrupt: false,
        connected: true,
    };
    room.players.push(player);
    socket.join(code);
    socket.emit('joined', { code, playerIndex: idx });
    io.to(code).emit('room_update', getGameState(room));
    addLog(room, `${player.emoji} ${player.name} 加入了房间`);
    io.to(code).emit('game_state', getGameState(room));
}

function getCurrentPlayer(room) {
    return room.players[room.currentPlayerIndex];
}

function addLog(room, msg) {
    room.log.unshift(msg);
    if (room.log.length > 80) room.log.pop();
}

function getGameState(room) {
    return {
        code: room.code,
        players: room.players,
        gameStarted: room.gameStarted,
        currentPlayerIndex: room.currentPlayerIndex,
        board: room.board,
        properties: room.properties,
        log: room.log.slice(0, 30),
        phase: room.phase,
        diceResult: room.diceResult,
        pendingAction: room.pendingAction,
        debtInfo: room.debtInfo || null,
        debug: IS_DEBUG,
    };
}

function processLanding(room, player, socket, code) {
    const tile = BOARD[player.position];

    if (tile.type === 'go') {
        player.money += 2000;
        addLog(room, `${player.emoji} ${player.name} 到达罗德岛舰桥，额外收取 ¥2,000`);
        nextTurn(room, code);
        return;
    }

    if (tile.type === 'safe') {
        addLog(room, `${player.emoji} ${player.name} 在蒙德城广场休整，安全！`);
        nextTurn(room, code);
        return;
    }

    if (tile.type === 'jail') {
        addLog(room, `  进入感染者隔离区，只是路过，安全！`);
        nextTurn(room, code);
        return;
    }

    if (tile.type === 'go_to_jail') {
        player.position = 10;
        player.jailTurns = 3;
        addLog(room, `  被卫生组织强制隔离！移送至隔离区`);
        nextTurn(room, code);
        return;
    }

    if (tile.type === 'tax') {
        player.money += tile.amount;
        addLog(room, `  触发【${tile.name}】，${tile.amount < 0 ? '支付' : '收取'} ¥${Math.abs(tile.amount)}`);
        if (!checkBankrupt(room, player, null, code)) {
            nextTurn(room, code);
        }
        return;
    }

    if (tile.type === 'chance') {
        if (room.chanceCards.length === 0) room.chanceCards = shuffle([...CHANCE_CARDS]);
        const card = room.chanceCards.shift();
        room.chanceCards.push(card);  // 放回底部
        addLog(room, `  抽到【罗德岛作战命令】：${card.text}`);
        applyCard(room, player, card, code);
        return;
    }

    if (tile.type === 'community') {
        if (room.communityCards.length === 0) room.communityCards = shuffle([...COMMUNITY_CARDS]);
        const card = room.communityCards.shift();
        room.communityCards.push(card);  // 放回底部
        addLog(room, `  抽到【龙门仲裁庭裁决】：${card.text}`);
        applyCard(room, player, card, code);
        return;
    }

    if (tile.type === 'property' || tile.type === 'port' || tile.type === 'utility') {
        const prop = room.properties[tile.id];

        // 无主地产 → 询问购买
        if (!prop) {
            room.pendingAction = { type: 'buy', tileId: tile.id };
            addLog(room, `  到达无主地产【${tile.name}】，售价 ¥${tile.price}`);
            io.to(code).emit('game_state', getGameState(room));
            return;
        }

        // 已抵押
        if (prop.mortgaged) {
            addLog(room, `  【${tile.name}】已抵押，无需付租`);
            nextTurn(room, code);
            return;
        }

        // 自己的地产
        if (prop.owner === player.id) {
            addLog(room, `  【${tile.name}】是自己的地产`);
            nextTurn(room, code);
            return;
        }

        // 他人地产 → 收租
        const owner = room.players.find(p => p.id === prop.owner);
        let rent = 0;

        if (tile.type === 'port') {
            const portCount = Object.entries(room.properties)
                .filter(([id, p]) => p.owner === prop.owner && BOARD[id].type === 'port').length;
            const portRents = [0, 250, 500, 1000, 2000];
            rent = portRents[portCount];
        } else if (tile.type === 'utility') {
            const utilCount = Object.entries(room.properties)
                .filter(([id, p]) => p.owner === prop.owner && BOARD[id].type === 'utility').length;
            const dice = room.diceResult.total;
            rent = utilCount === 1 ? dice * 4 : dice * 10;
        } else {
            rent = tile.rent[prop.level];
            // 同色加成：集齐同组所有地产，租金翻倍
            const groupTiles = BOARD.filter(t => t.type === 'property' && t.group === tile.group);
            const allOwned = groupTiles.every(t => room.properties[t.id]?.owner === prop.owner);
            if (allOwned && prop.level === 0) rent *= 2;
        }

        player.money -= rent;
        if (owner) owner.money += rent;
        addLog(room, `  支付租金 ¥${rent} 给 ${owner?.name || '银行'}`);
        if (!checkBankrupt(room, player, owner, code)) {
            nextTurn(room, code);
        }
        return;
    }

    nextTurn(room, code);
}

function applyCard(room, player, card, code) {
    if (card.type === 'collect_all') {
        room.players.forEach(p => {
            if (p.id !== player.id && !p.bankrupt) {
                p.money -= card.amount;
                player.money += card.amount;
            }
        });
    } else if (card.type === 'go_to_start') {
        player.position = 0;
        player.money += card.amount;
    } else {
        player.money += card.amount;
    }
    if (!checkBankrupt(room, player, null, code)) {
        nextTurn(room, code);
    }
}

function checkBankrupt(room, player, creditor, code) {
    if (player.money >= 0) return false; // 不欠债，无需处理

    // 计算可抵押资产总值
    const mortgageableValue = Object.entries(room.properties)
        .filter(([id, p]) => p.owner === player.id && !p.mortgaged)
        .reduce((sum, [id]) => sum + (BOARD[id].mortgage || Math.floor(BOARD[id].price / 2)), 0);

    // 即使抵押全部资产也无法偿还 → 直接破产
    if (player.money + mortgageableValue < 0) {
        forceBankrupt(room, player, creditor, code);
        return true; // 已破产，调用方应跳过 nextTurn（由内部处理）
    }

    // 有足够资产可以自救 → 进入负债阶段，暂停回合等待玩家操作
    room.phase = 'debt';
    room.debtInfo = {
        playerId: player.id,
        creditorId: creditor?.id || null,
    };
    addLog(room, `⚠️ ${player.emoji} ${player.name} 资金不足（¥${player.money.toLocaleString()}），请抵押资产偿还负债！`);
    io.to(code).emit('game_state', getGameState(room));
    return true; // 进入负债阶段，调用方不应继续 nextTurn
}

function forceBankrupt(room, player, creditor, code) {
    player.bankrupt = true;
    player.money = 0;
    addLog(room, `💀 ${player.emoji} ${player.name} 资金耗尽，退出泰拉财富争夺战！`);

    // 没收/转移地产
    Object.entries(room.properties).forEach(([id, p]) => {
        if (p.owner === player.id) {
            if (creditor) {
                p.owner = creditor.id;
                p.level = 0;
                p.mortgaged = false;
            } else {
                delete room.properties[id];
            }
        }
    });

    const activePlayers = room.players.filter(p => !p.bankrupt);
    if (activePlayers.length === 1) {
        const winner = activePlayers[0];
        room.phase = 'end';
        addLog(room, `🏆 ${winner.emoji} ${winner.name} 成为泰拉大陆最强干员首富！游戏结束！`);
        io.to(code).emit('game_state', getGameState(room));
    } else if (activePlayers.length === 0) {
        room.phase = 'end';
        addLog(room, `💀 全员破产，泰拉大陆陷入经济危机！游戏结束！`);
        io.to(code).emit('game_state', getGameState(room));
    } else {
        nextTurn(room, code);
    }
}

function nextTurn(room, code) {
    room.pendingAction = null;
    room.diceResult = null;

    const activePlayers = room.players.filter(p => !p.bankrupt);
    if (activePlayers.length <= 1 && room.players.length > 1) {
        room.phase = 'end';
        io.to(code).emit('game_state', getGameState(room));
        return;
    }

    // 找到下一个未破产的玩家
    let next = (room.currentPlayerIndex + 1) % room.players.length;
    while (room.players[next].bankrupt) {
        next = (next + 1) % room.players.length;
    }
    room.currentPlayerIndex = next;
    room.phase = 'rolling';

    const cur = room.players[next];
    addLog(room, `--- ${cur.emoji} ${cur.name} 的回合 ---`);
    io.to(code).emit('game_state', getGameState(room));
}

// ─── 启动 ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚢 明日方舟大富翁服务器运行在端口 ${PORT}`);
});
