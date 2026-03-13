// ── 棋盘自适应缩放 ────────────────────────────────────────────────────────────
// ── 棋盘自适应缩放 ────────────────────────────────────────────────────────────
function scaleBoardToFit() {
    const board = document.getElementById('board');
    const wrap  = document.getElementById('boardWrap');
    if (!board || !wrap) return;

    // 重置，避免旧 scale 干扰测量
    board.style.transform = 'scale(1)';

    const wrapW = wrap.clientWidth  - 24;
    const wrapH = wrap.clientHeight - 24;
    if (wrapW <= 0 || wrapH <= 0) return;

    // 棋盘是 11×11 grid：2个角格(×1.3) + 9个普通格，间隔2px×10
    // 总宽 = corner*2 + cell*9 + gap*10 = cell*1.3*2 + cell*9 + 20
    //       = cell * (2.6 + 9) + 20 = cell * 11.6 + 20
    // 解出 cell：
    const cellFromW = (wrapW - 20) / 11.6;
    const cellFromH = (wrapH - 20) / 11.6;
    const cell = Math.floor(Math.min(cellFromW, cellFromH, 80)); // 最大80px

    board.style.setProperty('--cell', cell + 'px');
}

window.addEventListener('resize', scaleBoardToFit);


const socket = io();

// ── 状态 ──────────────────────────────────────────────────────────────────────
let myId       = null;
let myCode     = null;
let myIndex    = null;
let gameState  = null;

const BOARD_SIZE = 40;

// 棋盘布局：将40格映射到11×11 grid position (row, col) 从外圈顺时针
// 底行(row11): 0~10 右→左
// 左列(row10~2): 11~19 下→上
// 顶行(row1): 20~30 左→右
// 右列(row2~10): 31~39 上→下
function getTileGridPos(index) {
    if (index <= 10)  return { row: 11, col: 11 - index };       // 底行 右→左
    if (index <= 19)  return { row: 11 - (index - 10), col: 1 }; // 左列 下→上
    if (index <= 30)  return { row: 1,  col: 1 + (index - 20) }; // 顶行 左→右
    return             { row: 1 + (index - 30), col: 11 };        // 右列 上→下
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Socket 事件 ───────────────────────────────────────────────────────────────
socket.on('joined', ({ code, playerIndex }) => {
    myCode  = code;
    myId    = socket.id;
    myIndex = playerIndex;
    $('roomCodeDisplay').textContent = code;
    $('lobby').classList.add('hidden');
    $('waitingRoom').classList.remove('hidden');
});

socket.on('room_update', (state) => {
    gameState = state;
    renderWaitingRoom(state);
});

socket.on('game_started', (state) => {
    gameState = state;
    $('waitingRoom').classList.add('hidden');
    $('gameArea').classList.remove('hidden');
    renderGame(state);
    setTimeout(scaleBoardToFit, 80);
});



socket.on('game_state', (state) => {
    gameState = state;
    if (!$('gameArea').classList.contains('hidden')) {
        renderGame(state);
    } else if (!$('waitingRoom').classList.contains('hidden')) {
        renderWaitingRoom(state);
        if (state.gameStarted) {
            $('waitingRoom').classList.add('hidden');
            $('gameArea').classList.remove('hidden');
            renderGame(state);
        }
    }
});

socket.on('error', msg => {
    alert('⚠️ ' + msg);
});

// ── Lobby 事件 ────────────────────────────────────────────────────────────────
$('createBtn').onclick = () => {
    const nick = $('nicknameInput').value.trim();
    socket.emit('create_room', { nickname: nick });
};

$('joinBtn').onclick = () => {
    const nick = $('nicknameInput').value.trim();
    const code = $('codeInput').value.trim();
    if (!code) { $('lobbyError').textContent = '请输入房间码'; return; }
    socket.emit('join_room', { code, nickname: nick });
};

$('nicknameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('createBtn').click();
});
$('codeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('joinBtn').click();
});

// ── 等待室渲染 ────────────────────────────────────────────────────────────────
function renderWaitingRoom(state) {
    const list = $('playerList');
    list.innerHTML = '';
    state.players.forEach((p, i) => {
        const div = document.createElement('div');
        div.className = 'player-item';
        div.style.borderLeft = `3px solid ${p.color}`;
        div.innerHTML = `<span class="p-emoji">${p.emoji}</span>
                     <span class="p-name" style="color:${p.color}">${p.name}</span>
                     ${i === 0 ? '<span style="font-size:0.7rem;color:#ffd54f;margin-left:auto">房主</span>' : ''}`;
        list.appendChild(div);
    });

    // 只有房主且人数符合要求才显示开始按钮
    const startBtn = $('startBtn');
    const minPlayers = state.debug ? 1 : 2;
    if (myIndex === 0 && state.players.length >= minPlayers) {
        startBtn.classList.remove('hidden');
    } else {
        startBtn.classList.add('hidden');
    }
}

$('startBtn').onclick = () => {
    socket.emit('start_game', { code: myCode });
};

// ── 主游戏渲染 ────────────────────────────────────────────────────────────────
function renderGame(state) {
    renderBoard(state);
    renderPlayerStatus(state);
    renderDiceArea(state);
    renderBuyArea(state);
    renderDebtArea(state);
    renderMyProperties(state);
    renderLog(state);

    // 新增：游戏结束时显示胜利弹窗
    if (state.phase === 'end') {
        const winner = state.players.find(p => !p.bankrupt);
        if (winner && !document.getElementById('winModal')) {
            showWinModal(winner);
        }
    }
}

function showWinModal(winner) {
    // 防止重复创建
    const existing = document.getElementById('winModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'winModal';
    modal.className = 'modal';
    modal.innerHTML = `
    <div class="modal-content">
      <div style="font-size:3rem">🏆</div>
      <h2 style="color:var(--gold);margin:12px 0">
        ${winner.emoji} ${winner.name} 获胜！
      </h2>
      <p style="color:var(--text2);margin-bottom:8px">泰拉大陆最强干员首富</p>
      <p style="font-size:1.1rem;color:var(--accent)">
        最终资产：¥${winner.money.toLocaleString()}
      </p>
      <button class="btn btn-primary" style="margin-top:20px"
        onclick="location.reload()">返回大厅</button>
    </div>
  `;
    document.body.appendChild(modal);
}


// ── 棋盘渲染 ──────────────────────────────────────────────────────────────────

// 从 server 同步的 BOARD 数据（客户端内嵌）
const BOARD = [
    { id:0,  name:'罗德岛舰桥',       emoji:'🚢', type:'go' },
    { id:1,  name:'龙门贫民窟',       emoji:'🏚️', type:'property', color:'brown',    price:600,  group:'龙门(棕)' },
    { id:2,  name:'龙门仲裁庭裁决',   emoji:'⚖️', type:'community' },
    { id:3,  name:'龙门商业街',       emoji:'🏪', type:'property', color:'brown',    price:600,  group:'龙门(棕)' },
    { id:4,  name:'源石病治疗费',     emoji:'💊', type:'tax' },
    { id:5,  name:'停靠港·东',       emoji:'⚓', type:'port',     price:2000 },
    { id:6,  name:'炎国·城墙',       emoji:'🏯', type:'property', color:'sky',      price:1000, group:'炎国(天蓝)' },
    { id:7,  name:'罗德岛作战命令',   emoji:'📜', type:'chance' },
    { id:8,  name:'炎国·明面大街',   emoji:'🏮', type:'property', color:'sky',      price:1000, group:'炎国(天蓝)' },
    { id:9,  name:'炎国·炎都皇宫',   emoji:'🔥', type:'property', color:'sky',      price:1200, group:'炎国(天蓝)' },
    { id:10, name:'感染者隔离区',     emoji:'⛔', type:'jail' },
    { id:11, name:'维多利亚·伦蒂尼姆', emoji:'🎩', type:'property', color:'pink',   price:1400, group:'维多利亚(粉)' },
    { id:12, name:'源石矿脉',         emoji:'💎', type:'utility',  price:1500 },
    { id:13, name:'维多利亚·威斯特洛斯', emoji:'🏰', type:'property', color:'pink', price:1400, group:'维多利亚(粉)' },
    { id:14, name:'维多利亚·大不列颠', emoji:'👑', type:'property', color:'pink',   price:1600, group:'维多利亚(粉)' },
    { id:15, name:'停靠港·南',       emoji:'⚓', type:'port',     price:2000 },
    { id:16, name:'拉特兰·教廷广场', emoji:'✝️', type:'property', color:'orange',   price:1800, group:'拉特兰(橙)' },
    { id:17, name:'龙门仲裁庭裁决',   emoji:'⚖️', type:'community' },
    { id:18, name:'拉特兰·圣约之城', emoji:'🕍', type:'property', color:'orange',   price:1800, group:'拉特兰(橙)' },
    { id:19, name:'拉特兰·神迹殿堂', emoji:'⛪', type:'property', color:'orange',   price:2000, group:'拉特兰(橙)' },
    { id:20, name:'蒙德城广场',       emoji:'🌸', type:'safe' },
    { id:21, name:'乌萨斯·帝国议会', emoji:'🐻', type:'property', color:'red',      price:2200, group:'乌萨斯(红)' },
    { id:22, name:'罗德岛作战命令',   emoji:'📜', type:'chance' },
    { id:23, name:'乌萨斯·雪原要塞', emoji:'❄️', type:'property', color:'red',      price:2200, group:'乌萨斯(红)' },
    { id:24, name:'乌萨斯·冬境皇都', emoji:'🏔️', type:'property', color:'red',      price:2400, group:'乌萨斯(红)' },
    { id:25, name:'停靠港·西',       emoji:'⚓', type:'port',     price:2000 },
    { id:26, name:'卡西米尔·竞技场', emoji:'⚔️', type:'property', color:'yellow',   price:2600, group:'卡西米尔(黄)' },
    { id:27, name:'卡西米尔·贵族庄园', emoji:'🏇', type:'property', color:'yellow', price:2600, group:'卡西米尔(黄)' },
    { id:28, name:'整合运动通讯网',   emoji:'📡', type:'utility',  price:1500 },
    { id:29, name:'卡西米尔·王都华沙', emoji:'🌟', type:'property', color:'yellow', price:2800, group:'卡西米尔(黄)' },
    { id:30, name:'被强制隔离',       emoji:'☣️', type:'go_to_jail' },
    { id:31, name:'萨尔贡·沙漠遗迹', emoji:'🏜️', type:'property', color:'green',    price:3000, group:'萨尔贡(绿)' },
    { id:32, name:'萨尔贡·古城废墟', emoji:'🗿', type:'property', color:'green',    price:3000, group:'萨尔贡(绿)' },
    { id:33, name:'龙门仲裁庭裁决',   emoji:'⚖️', type:'community' },
    { id:34, name:'萨尔贡·永恒圣所', emoji:'⛩️', type:'property', color:'green',    price:3200, group:'萨尔贡(绿)' },
    { id:35, name:'停靠港·北',       emoji:'⚓', type:'port',     price:2000 },
    { id:36, name:'罗德岛作战命令',   emoji:'📜', type:'chance' },
    { id:37, name:'莱塔尼亚·音律联合会', emoji:'🎵', type:'property', color:'darkblue', price:3500, group:'莱塔尼亚(深蓝)' },
    { id:38, name:'武器维护费',       emoji:'🔧', type:'tax' },
    { id:39, name:'莱塔尼亚·傀儡王座', emoji:'🎭', type:'property', color:'darkblue', price:4000, group:'莱塔尼亚(深蓝)' },
];

function renderBoard(state) {
    const boardEl = $('board');
    boardEl.innerHTML = '';

    // 创建 11×11 grid 容器数组
    const cells = Array.from({ length: 11 }, () => Array(11).fill(null));

    // 填充外圈格子
    BOARD.forEach((tile, idx) => {
        const { row, col } = getTileGridPos(idx);
        const prop = state.properties[tile.id];
        const owner = prop ? state.players.find(p => p.id === prop.owner) : null;
        const isCorner = [0, 10, 20, 30].includes(idx);

        const div = document.createElement('div');
        div.className = 'tile' + (isCorner ? ' corner' : '');
        if (['tax','chance','community','go_to_jail','safe','jail','go'].includes(tile.type)) {
            div.classList.add('special');
        }
        if (prop?.mortgaged) div.classList.add('mortgaged');

        // 颜色条
        if (tile.color) {
            const bar = document.createElement('div');
            bar.className = `t-color color-${tile.color}`;
            if (owner) bar.style.boxShadow = `0 0 6px ${owner.color}`;
            div.appendChild(bar);
        }

        // 所有者边框
        if (owner) {
            div.style.outline = `2px solid ${owner.color}`;
            div.style.outlineOffset = '-2px';
        }

        // emoji
        const emojiEl = document.createElement('div');
        emojiEl.className = 't-emoji';
        emojiEl.textContent = tile.emoji;
        div.appendChild(emojiEl);

        // 名称
        const nameEl = document.createElement('div');
        nameEl.className = 't-name';
        nameEl.textContent = tile.name;
        div.appendChild(nameEl);

        // 价格
        if (tile.price) {
            const priceEl = document.createElement('div');
            priceEl.className = 't-price';
            priceEl.textContent = `¥${tile.price.toLocaleString()}`;
            div.appendChild(priceEl);
        }

        // 等级标记
        if (prop && prop.level > 0) {
            const lvEl = document.createElement('div');
            lvEl.className = 't-level';
            lvEl.textContent = '★'.repeat(prop.level);
            div.appendChild(lvEl);
        }

        // 玩家棋子
        const pawnsOnTile = state.players.filter(p => p.position === idx && !p.bankrupt);
        if (pawnsOnTile.length > 0) {
            const pawnsEl = document.createElement('div');
            pawnsEl.className = 't-pawns';
            pawnsOnTile.forEach(p => {
                const sp = document.createElement('span');
                sp.textContent = p.emoji;
                sp.title = p.name;
                sp.style.filter = `drop-shadow(0 0 3px ${p.color})`;
                pawnsEl.appendChild(sp);
            });
            div.appendChild(pawnsEl);
        }

        div.style.gridRow    = row;
        div.style.gridColumn = col;
        boardEl.appendChild(div);
    });

    // 中央区域
    const center = document.createElement('div');
    center.className = 'board-center';
    center.style.gridRow    = '2 / 11';
    center.style.gridColumn = '2 / 11';
    center.innerHTML = `
    <div class="center-logo">⚔️</div>
    <h2>明日方舟大富翁</h2>
    <p>泰拉大陆 · 财富争夺战</p>
    <p style="font-size:0.65rem;color:#4fc3f7;margin-top:8px">房间码：<strong>${state.code}</strong></p>
  `;
    boardEl.appendChild(center);
    requestAnimationFrame(scaleBoardToFit);
}

// ── 玩家状态栏 ────────────────────────────────────────────────────────────────
function renderPlayerStatus(state) {
    const el = $('playerStatus');
    el.innerHTML = '';
    state.players.forEach((p, i) => {
        const card = document.createElement('div');
        card.className = 'ps-card' +
            (i === state.currentPlayerIndex && !p.bankrupt ? ' active-turn' : '') +
            (p.bankrupt ? ' bankrupt' : '');
        card.style.borderLeftColor = p.color;
        const tile = BOARD[p.position];
        const jailInfo = p.jailTurns > 0 ? ` 🔒×${p.jailTurns}` : '';
        card.innerHTML = `
          <div class="ps-name">${p.emoji} ${p.name} ${p.bankrupt ? '💀 已退出' : ''}</div>
          <div class="ps-money">¥${p.money.toLocaleString()}</div>
          <div class="ps-pos">${p.bankrupt ? '——' : (BOARD[p.position]?.name ?? '')}</div>
        `;

        el.appendChild(card);
    });
}

// ── 骰子区 ────────────────────────────────────────────────────────────────────
const DICE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

function renderDiceArea(state) {
    const isMyTurn = state.players[state.currentPlayerIndex]?.id === myId;
    const me = state.players.find(p => p.id === myId);
    const inJail = me && me.jailTurns > 0;

    // 骰子显示
    if (state.diceResult) {
        $('dice1').textContent = DICE_FACES[state.diceResult.d1] || state.diceResult.d1;
        $('dice2').textContent = DICE_FACES[state.diceResult.d2] || state.diceResult.d2;
    } else {
        $('dice1').textContent = '🎲';
        $('dice2').textContent = '🎲';
    }

    // 普通掷骰
    const rollBtn = $('rollBtn');
    if (isMyTurn && state.phase === 'rolling' && !inJail && state.gameStarted) {
        rollBtn.classList.remove('hidden');
        rollBtn.disabled = false;
    } else {
        rollBtn.classList.add('hidden');
    }

    // 隔离掷骰
    const jailRoll = $('jailRollBtn');
    const jailPay  = $('jailPayBtn');
    if (isMyTurn && state.phase === 'rolling' && inJail) {
        jailRoll.classList.remove('hidden');
        jailPay.classList.remove('hidden');
    } else {
        jailRoll.classList.add('hidden');
        jailPay.classList.add('hidden');
    }

    // 游戏结束
    if (state.phase === 'end' || state.phase === 'debt') {
        rollBtn.classList.add('hidden');
        jailRoll.classList.add('hidden');
        jailPay.classList.add('hidden');
    }
}

$('rollBtn').onclick    = () => socket.emit('roll_dice',  { code: myCode });
$('jailRollBtn').onclick = () => socket.emit('jail_roll', { code: myCode });
$('jailPayBtn').onclick  = () => socket.emit('jail_pay',  { code: myCode });

// ── 购买区 ────────────────────────────────────────────────────────────────────
function renderBuyArea(state) {
    const currentPlayer = state.players[state.currentPlayerIndex];
    const isMyTurn = currentPlayer?.id === myId;
    const me = state.players.find(p => p.id === myId);
    const pending = state.pendingAction;

    // 新增：自己已破产则隐藏所有操作区
    if (me?.bankrupt) {
        $('buyArea').classList.add('hidden');
        return;
    }

    if (isMyTurn && pending?.type === 'buy') {
        const tile = BOARD[pending.tileId];
        $('buyPrompt').textContent =
            `${tile.emoji} ${tile.name}  售价 ¥${tile.price}  (余额 ¥${me.money.toLocaleString()})`;
        $('buyArea').classList.remove('hidden');
    } else {
        $('buyArea').classList.add('hidden');
    }
}


$('buyBtn').onclick  = () => socket.emit('buy_property', { code: myCode });
$('skipBtn').onclick = () => socket.emit('skip_buy',     { code: myCode });

// ── 负债区 ────────────────────────────────────────────────────────────────────
function renderDebtArea(state) {
    const debtArea = $('debtArea');
    if (!debtArea) return;

    const me = state.players.find(p => p.id === myId);
    if (!me) { debtArea.classList.add('hidden'); return; }

    if (state.phase === 'debt' && state.debtInfo?.playerId === myId && me.money < 0) {
        $('debtPrompt').textContent =
            `⚠️ 你当前负债 ¥${Math.abs(me.money).toLocaleString()}，请抵押资产偿还！`;
        debtArea.classList.remove('hidden');
    } else {
        debtArea.classList.add('hidden');
    }
}

$('debtResolveBtn').onclick = () => {
    socket.emit('debt_resolve', { code: myCode });
};


// ── 我的地产 ──────────────────────────────────────────────────────────────────
function renderMyProperties(state) {
    const list = $('propList');
    list.innerHTML = '';

    const myProps = Object.entries(state.properties)
        .filter(([id, p]) => p.owner === myId)
        .map(([id, p]) => ({ tile: BOARD[id], prop: p, id: parseInt(id) }));

    if (myProps.length === 0) {
        list.innerHTML = '<div style="font-size:0.72rem;color:#556">暂无地产</div>';
        return;
    }

    myProps.forEach(({ tile, prop, id }) => {
        const div = document.createElement('div');
        div.className = 'prop-item';
        const dot = document.createElement('div');
        dot.className = 'prop-dot';
        dot.style.background = `var(--${tile.color || 'text2'})`;
        div.appendChild(dot);

        const info = document.createElement('span');
        info.textContent = `${tile.emoji} ${tile.name}`;
        if (prop.level > 0) info.textContent += ` ${'★'.repeat(prop.level)}`;
        if (prop.mortgaged) info.textContent += ' [抵押]';
        div.appendChild(info);

        const btns = document.createElement('div');
        btns.className = 'prop-btns';

        // 升级按钮（仅限property类型，未抵押，等级<5）
        if (tile.type === 'property' && !prop.mortgaged && prop.level < 5) {
            const upBtn = document.createElement('button');
            upBtn.textContent = '升级';
            upBtn.onclick = () => socket.emit('upgrade_property', { code: myCode, tileId: id });
            btns.appendChild(upBtn);
        }

        // 抵押按钮
        if (!prop.mortgaged) {
            const mortBtn = document.createElement('button');
            mortBtn.textContent = '抵押';
            mortBtn.onclick = () => {
                if (confirm(`确认抵押【${tile.name}】？`)) {
                    socket.emit('mortgage_property', { code: myCode, tileId: id });
                }
            };
            btns.appendChild(mortBtn);
        }

        div.appendChild(btns);
        list.appendChild(div);
    });
}

// ── 日志 ──────────────────────────────────────────────────────────────────────
function renderLog(state) {
    const list = $('logList');
    list.innerHTML = '';
    state.log.forEach(msg => {
        const div = document.createElement('div');
        div.className = 'log-item' +
            (msg.includes('---') ? ' log-turn' : '') +
            (msg.includes('🏆') ? ' log-win'  : '');
        div.textContent = msg;
        list.appendChild(div);
    });
}

// ── 聊天 ──────────────────────────────────────────────────────────────────────
$('chatBtn').onclick = sendChat;
$('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
});

function sendChat() {
    const msg = $('chatInput').value.trim();
    if (!msg) return;
    socket.emit('chat', { code: myCode, message: msg });
    $('chatInput').value = '';
}

// ── 卡牌弹窗（由 server 推送 show_card 事件触发） ────────────────────────────
socket.on('show_card', ({ icon, text }) => {
    $('cardIcon').textContent = icon;
    $('cardText').textContent = text;
    $('cardModal').classList.remove('hidden');
});

$('cardClose').onclick = () => {
    $('cardModal').classList.add('hidden');
};
