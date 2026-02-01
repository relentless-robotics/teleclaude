// PartyKit Multiplayer Server for Void Runner
// Handles real-time synchronization of player positions, game state, and room management

export default class VoidRunnerServer {
  constructor(party) {
    this.party = party;
    this.players = new Map(); // Map<connectionId, playerData>
    this.gameState = {
      started: false,
      seed: null,
      host: null,
      startTime: null
    };
  }

  onConnect(connection, ctx) {
    console.log(`[${this.party.id}] Player connected:`, connection.id);

    // Send current room state to new connection
    connection.send(JSON.stringify({
      type: 'room-state',
      players: Array.from(this.players.values()),
      gameState: this.gameState,
      yourId: connection.id
    }));

    // Set first player as host if no host exists
    if (!this.gameState.host && this.players.size === 0) {
      this.gameState.host = connection.id;
    }

    // Broadcast new player joined to others
    this.broadcast({
      type: 'player-joined',
      playerId: connection.id,
      isHost: this.gameState.host === connection.id
    }, connection.id);
  }

  onMessage(message, connection) {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'join':
          this.handleJoin(data, connection);
          break;

        case 'position':
          this.handlePosition(data, connection);
          break;

        case 'start-game':
          this.handleStartGame(data, connection);
          break;

        case 'death':
          this.handleDeath(data, connection);
          break;

        case 'powerup':
          this.handlePowerup(data, connection);
          break;

        case 'milestone':
          this.handleMilestone(data, connection);
          break;

        default:
          console.log(`[${this.party.id}] Unknown message type:`, data.type);
      }
    } catch (error) {
      console.error(`[${this.party.id}] Error processing message:`, error);
    }
  }

  onClose(connection) {
    console.log(`[${this.party.id}] Player disconnected:`, connection.id);

    const player = this.players.get(connection.id);
    this.players.delete(connection.id);

    // Broadcast player left
    this.broadcast({
      type: 'player-left',
      playerId: connection.id,
      playerName: player?.name
    });

    // Transfer host if needed
    if (this.gameState.host === connection.id && this.players.size > 0) {
      const newHost = Array.from(this.players.keys())[0];
      this.gameState.host = newHost;

      this.broadcast({
        type: 'host-changed',
        newHost: newHost
      });
    }

    // Reset game if all players left
    if (this.players.size === 0) {
      this.gameState = {
        started: false,
        seed: null,
        host: null,
        startTime: null
      };
    }
  }

  handleJoin(data, connection) {
    const player = {
      id: connection.id,
      name: data.name || `Player ${this.players.size + 1}`,
      shipType: data.shipType || 'basic',
      color: data.color || this.getPlayerColor(this.players.size),
      isHost: this.gameState.host === connection.id,
      alive: true,
      distance: 0,
      score: 0,
      position: { x: 0, y: 0, z: 0, lane: 1 }
    };

    this.players.set(connection.id, player);

    // Broadcast updated player to all
    this.broadcast({
      type: 'player-updated',
      player: player
    });

    console.log(`[${this.party.id}] Player joined:`, player.name);
  }

  handlePosition(data, connection) {
    const player = this.players.get(connection.id);
    if (!player) return;

    player.position = {
      x: data.x,
      y: data.y,
      z: data.z,
      lane: data.lane,
      jumping: data.jumping,
      ducking: data.ducking
    };

    player.distance = data.distance || 0;
    player.score = data.score || 0;

    // Broadcast position to all other players (except sender)
    this.broadcast({
      type: 'player-position',
      playerId: connection.id,
      position: player.position,
      distance: player.distance,
      score: player.score
    }, connection.id);
  }

  handleStartGame(data, connection) {
    // Only host can start the game
    if (connection.id !== this.gameState.host) {
      connection.send(JSON.stringify({
        type: 'error',
        message: 'Only the host can start the game'
      }));
      return;
    }

    // Generate random seed for synchronized procedural generation
    const seed = Math.floor(Math.random() * 1000000);

    this.gameState.started = true;
    this.gameState.seed = seed;
    this.gameState.startTime = Date.now();

    // Reset all players
    this.players.forEach(player => {
      player.alive = true;
      player.distance = 0;
      player.score = 0;
    });

    // Broadcast game start to all players
    this.broadcast({
      type: 'game-start',
      seed: seed,
      players: Array.from(this.players.values()),
      startTime: this.gameState.startTime
    });

    console.log(`[${this.party.id}] Game started with seed:`, seed);
  }

  handleDeath(data, connection) {
    const player = this.players.get(connection.id);
    if (!player) return;

    player.alive = false;
    player.distance = data.distance || player.distance;
    player.score = data.score || player.score;

    // Broadcast death to all
    this.broadcast({
      type: 'player-death',
      playerId: connection.id,
      playerName: player.name,
      finalDistance: player.distance,
      finalScore: player.score
    });

    // Check if game over (only one player left or all dead)
    const alivePlayers = Array.from(this.players.values()).filter(p => p.alive);

    if (alivePlayers.length <= 1 && this.players.size > 1) {
      // Game over - announce winner
      const winner = alivePlayers[0] || this.getTopPlayer();

      this.broadcast({
        type: 'game-over',
        winner: winner,
        finalStandings: this.getFinalStandings()
      });

      this.gameState.started = false;
    }

    console.log(`[${this.party.id}] Player died:`, player.name, 'Distance:', player.distance);
  }

  handlePowerup(data, connection) {
    // Broadcast powerup pickup to all (for visual sync)
    this.broadcast({
      type: 'player-powerup',
      playerId: connection.id,
      powerupType: data.powerupType,
      position: data.position
    }, connection.id);
  }

  handleMilestone(data, connection) {
    const player = this.players.get(connection.id);
    if (!player) return;

    // Broadcast milestone achievement
    this.broadcast({
      type: 'milestone-reached',
      playerId: connection.id,
      playerName: player.name,
      milestone: data.milestone
    });
  }

  broadcast(message, excludeId = null) {
    const messageStr = JSON.stringify(message);

    this.party.getConnections().forEach(connection => {
      if (!excludeId || connection.id !== excludeId) {
        connection.send(messageStr);
      }
    });
  }

  getPlayerColor(index) {
    const colors = [
      '#ff00ff', // Magenta
      '#00ffff', // Cyan
      '#ffff00', // Yellow
      '#00ff00'  // Green
    ];
    return colors[index % colors.length];
  }

  getTopPlayer() {
    let topPlayer = null;
    let maxDistance = 0;

    this.players.forEach(player => {
      if (player.distance > maxDistance) {
        maxDistance = player.distance;
        topPlayer = player;
      }
    });

    return topPlayer;
  }

  getFinalStandings() {
    return Array.from(this.players.values())
      .sort((a, b) => b.distance - a.distance)
      .map((player, index) => ({
        rank: index + 1,
        name: player.name,
        distance: player.distance,
        score: player.score,
        alive: player.alive
      }));
  }
}
