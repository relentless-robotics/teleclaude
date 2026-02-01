// Simple Multiplayer Manager using PeerJS
class MultiplayerManager {
    constructor() {
        this.peer = null;
        this.connections = [];
        this.isHost = false;
        this.roomCode = '';
        this.players = new Map();
    }

    init() {
        if (typeof Peer === 'undefined') {
            console.warn('PeerJS not loaded');
            return;
        }
        this.peer = new Peer();
        this.peer.on('open', (id) => console.log('Peer ID:', id));
        this.peer.on('connection', (conn) => this.handleConnection(conn));
    }

    createRoom() {
        if (!this.peer) this.init();
        this.isHost = true;
        this.roomCode = this.generateRoomCode();
        document.getElementById('room-code-display').textContent = this.roomCode;
        document.getElementById('room-info').classList.remove('hidden');
        document.getElementById('player-count').textContent = '1';
        console.log('Room created:', this.roomCode);
    }

    joinRoom(code) {
        if (!this.peer) this.init();
        this.roomCode = code;
        const conn = this.peer.connect(code);
        this.handleConnection(conn);
    }

    handleConnection(conn) {
        this.connections.push(conn);
        conn.on('data', (data) => this.handleData(data, conn));
        conn.on('open', () => {
            console.log('Connected to peer');
            this.updatePlayerCount();
        });
    }

    handleData(data, conn) {
        if (data.type === 'position') {
            this.players.set(conn.peer, data);
        } else if (data.type === 'death') {
            this.players.set(conn.peer, { ...this.players.get(conn.peer), dead: true });
        }
    }

    sendPosition(bird) {
        this.connections.forEach(conn => {
            if (conn.open) {
                conn.send({ type: 'position', x: bird.x, y: bird.y, rotation: bird.rotation });
            }
        });
    }

    sendDeath() {
        this.connections.forEach(conn => {
            if (conn.open) {
                conn.send({ type: 'death' });
            }
        });
    }

    updatePlayerCount() {
        const count = this.connections.filter(c => c.open).length + 1;
        document.getElementById('player-count').textContent = count;
    }

    generateRoomCode() {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    }

    startGame() {
        if (this.isHost) {
            const seed = Math.random() * 10000;
            this.connections.forEach(conn => {
                if (conn.open) {
                    conn.send({ type: 'start', seed: seed });
                }
            });
            if (window.game) {
                game.setMultiplayerSeed(seed);
                uiManager.startGame();
            }
        }
    }

    drawGhostPlayers(ctx) {
        this.players.forEach((player, peerId) => {
            if (!player.dead) {
                ctx.save();
                ctx.globalAlpha = 0.5;
                ctx.translate(player.x || 100, player.y || 200);
                ctx.rotate((player.rotation || 0) * Math.PI / 180);
                ctx.fillStyle = '#FF6B35';
                ctx.beginPath();
                ctx.arc(0, 0, 15, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        });
    }
}

const mpManager = new MultiplayerManager();
