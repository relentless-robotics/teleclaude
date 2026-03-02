// Real P2P Multiplayer using PeerJS (no server required!)
// Peer-to-peer connections for 2-4 players

class SimpleMultiplayerManager {
  constructor(game) {
    this.game = game;
    this.peer = null;
    this.connections = new Map(); // Map of playerId -> connection
    this.roomId = null;
    this.myPlayerId = null;
    this.playerName = null;
    this.players = new Map(); // Map of playerId -> player mesh
    this.playerData = new Map(); // Map of playerId -> { name, distance, alive }
    this.isHost = false;
    this.connected = false;
    this.gameStarted = false;
    this.seed = null;
    this.nameTags = new Map();
    this.playerColors = ['#ff00ff', '#00ffff', '#ffff00', '#00ff00'];
  }

  // Generate a 6-character room code from peer ID
  generateRoomCode(peerId) {
    // Use the first 6 chars of peer ID, uppercased
    return peerId.substring(0, 6).toUpperCase();
  }

  async createRoom(playerName) {
    this.playerName = playerName;
    this.isHost = true;

    return new Promise((resolve, reject) => {
      // Create peer connection
      this.peer = new Peer();

      this.peer.on('open', (id) => {
        this.myPlayerId = id;
        this.roomId = this.generateRoomCode(id);
        this.connected = true;

        // Generate seed for synchronized obstacles
        this.seed = Math.floor(Math.random() * 1000000);

        console.log('Room created with code:', this.roomId);
        console.log('Full Peer ID:', id);

        // Add self to player list
        this.playerData.set(this.myPlayerId, {
          name: playerName,
          distance: 0,
          alive: true,
          color: this.playerColors[0],
          isHost: true
        });

        resolve(this.roomId);
      });

      this.peer.on('connection', (conn) => {
        console.log('Player connecting:', conn.peer);
        this.handleConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.error('Peer error:', err);
        reject(err);
      });
    });
  }

  async joinRoom(roomCode, playerName) {
    this.playerName = playerName;
    this.isHost = false;
    this.roomId = roomCode;

    return new Promise((resolve, reject) => {
      // Create peer connection
      this.peer = new Peer();

      this.peer.on('open', (id) => {
        this.myPlayerId = id;

        console.log('My Peer ID:', id);
        console.log('Attempting to connect to room:', roomCode);

        // Try to find the host
        // Room codes are shortened peer IDs, so we need to reconstruct or use full ID
        // For simplicity, let user paste full peer ID or we store mapping

        // Attempt connection - for now, expect full peer ID in room code
        const conn = this.peer.connect(roomCode.toLowerCase());

        conn.on('open', () => {
          console.log('Connected to host!');
          this.connected = true;

          // Send join message
          conn.send({
            type: 'join',
            playerId: this.myPlayerId,
            playerName: playerName
          });

          this.connections.set('host', conn);

          this.handleConnection(conn);
          resolve();
        });

        conn.on('error', (err) => {
          console.error('Connection error:', err);
          reject(err);
        });
      });

      this.peer.on('error', (err) => {
        console.error('Peer error:', err);
        reject(err);
      });
    });
  }

  handleConnection(conn) {
    const playerId = conn.peer;

    conn.on('data', (data) => {
      this.handleMessage(data, playerId);
    });

    conn.on('close', () => {
      console.log('Player disconnected:', playerId);
      this.removePlayer(playerId);
      this.connections.delete(playerId);
    });

    this.connections.set(playerId, conn);

    // If host, send current game state
    if (this.isHost) {
      conn.send({
        type: 'welcome',
        seed: this.seed,
        players: Array.from(this.playerData.entries())
      });
    }
  }

  handleMessage(data, fromPlayerId) {
    switch (data.type) {
      case 'join':
        if (this.isHost) {
          // Add new player
          const colorIndex = this.playerData.size % this.playerColors.length;
          this.playerData.set(fromPlayerId, {
            name: data.playerName,
            distance: 0,
            alive: true,
            color: this.playerColors[colorIndex],
            isHost: false
          });

          // Broadcast updated player list to all
          this.broadcastPlayerList();

          // Update UI
          if (this.game.ui) {
            this.game.ui.updateLobbyPlayerList(this.getPlayerListForUI());
          }
        }
        break;

      case 'welcome':
        // Receive game state from host
        this.seed = data.seed;
        this.playerData = new Map(data.players);

        // Add self to player data
        const colorIndex = this.playerData.size % this.playerColors.length;
        this.playerData.set(this.myPlayerId, {
          name: this.playerName,
          distance: 0,
          alive: true,
          color: this.playerColors[colorIndex],
          isHost: false
        });

        // Update UI
        if (this.game.ui) {
          this.game.ui.updateLobbyPlayerList(this.getPlayerListForUI());
        }
        break;

      case 'playerList':
        this.playerData = new Map(data.players);
        if (this.game.ui) {
          this.game.ui.updateLobbyPlayerList(this.getPlayerListForUI());
        }
        break;

      case 'startGame':
        this.seed = data.seed;
        this.startMultiplayerGame();
        break;

      case 'position':
        this.updatePlayerPosition(fromPlayerId, data);
        break;

      case 'death':
        this.handlePlayerDeath(fromPlayerId, data);
        break;
    }
  }

  broadcastPlayerList() {
    const playerList = Array.from(this.playerData.entries());
    this.broadcast({
      type: 'playerList',
      players: playerList
    });
  }

  getPlayerListForUI() {
    const players = [];
    this.playerData.forEach((data, id) => {
      players.push({
        id: id,
        name: data.name,
        color: data.color,
        isHost: data.isHost || false
      });
    });
    return players;
  }

  broadcast(message) {
    this.connections.forEach((conn) => {
      if (conn.open) {
        conn.send(message);
      }
    });
  }

  startGame() {
    if (!this.isHost) {
      console.warn('Only host can start the game');
      return;
    }

    // Generate seed if not already set
    if (!this.seed) {
      this.seed = Math.floor(Math.random() * 1000000);
    }

    // Notify all players to start
    this.broadcast({
      type: 'startGame',
      seed: this.seed
    });

    // Start game locally
    this.startMultiplayerGame();
  }

  startMultiplayerGame() {
    this.gameStarted = true;

    // Hide lobby, show game
    if (this.game.ui) {
      this.game.ui.showScreen('game');
    }

    // Start game with seed
    if (this.game) {
      this.game.startMultiplayer(this.seed);
    }
  }

  sendPosition(player) {
    if (!this.connected || !this.gameStarted) return;

    const message = {
      type: 'position',
      x: player.mesh.position.x,
      y: player.mesh.position.y,
      z: player.mesh.position.z,
      lane: player.lane,
      distance: this.game.scoreManager ? this.game.scoreManager.getStats().distance : 0
    };

    this.broadcast(message);
  }

  updatePlayerPosition(playerId, data) {
    // Update player data
    if (this.playerData.has(playerId)) {
      const pData = this.playerData.get(playerId);
      pData.distance = data.distance || 0;
    }

    // Update or create player mesh
    if (!this.players.has(playerId)) {
      this.createPlayerMesh(playerId);
    }

    const mesh = this.players.get(playerId);
    if (mesh && data) {
      // Smooth interpolation
      mesh.position.x += (data.x - mesh.position.x) * 0.3;
      mesh.position.y += (data.y - mesh.position.y) * 0.3;
      mesh.position.z += (data.z - mesh.position.z) * 0.3;

      // Store data
      mesh.userData.distance = data.distance || 0;
      mesh.userData.playerName = this.playerData.get(playerId)?.name || 'Player';
    }
  }

  createPlayerMesh(playerId) {
    const playerData = this.playerData.get(playerId);
    const color = playerData?.color || '#ffffff';

    // Create a semi-transparent ghost ship
    const geometry = new THREE.Group();

    const bodyGeometry = new THREE.BoxGeometry(0.8, 0.4, 1.2);
    const bodyMaterial = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.5
    });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    geometry.add(body);

    const wingGeometry = new THREE.BoxGeometry(2, 0.1, 0.6);
    const wingMaterial = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.4
    });
    const wings = new THREE.Mesh(wingGeometry, wingMaterial);
    wings.position.y = -0.2;
    geometry.add(wings);

    geometry.position.set(0, 1, -10);
    geometry.userData = {
      playerId: playerId,
      playerName: playerData?.name || 'Player',
      distance: 0
    };

    this.game.scene.add(geometry);
    this.players.set(playerId, geometry);
  }

  handlePlayerDeath(playerId, data) {
    if (this.playerData.has(playerId)) {
      const pData = this.playerData.get(playerId);
      pData.alive = false;
      pData.finalDistance = data.distance;
      pData.finalScore = data.score;
    }

    // Remove mesh
    this.removePlayer(playerId);
  }

  removePlayer(playerId) {
    if (this.players.has(playerId)) {
      const mesh = this.players.get(playerId);
      this.game.scene.remove(mesh);
      this.players.delete(playerId);
    }

    if (this.playerData.has(playerId)) {
      this.playerData.delete(playerId);
    }

    // Update UI if in lobby
    if (!this.gameStarted && this.game.ui) {
      this.game.ui.updateLobbyPlayerList(this.getPlayerListForUI());
    }
  }

  sendDeath(distance, score) {
    if (!this.connected) return;

    this.broadcast({
      type: 'death',
      distance: distance,
      score: score
    });
  }

  updateOtherPlayers(deltaTime) {
    // Players are updated via position messages
    // No additional update needed here
  }

  disconnect() {
    this.connections.forEach((conn) => {
      conn.close();
    });
    this.connections.clear();

    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }

    this.cleanup();
  }

  cleanup() {
    this.players.forEach((mesh) => {
      this.game.scene.remove(mesh);
    });
    this.players.clear();
    this.playerData.clear();
    this.connected = false;
    this.gameStarted = false;
  }
}
