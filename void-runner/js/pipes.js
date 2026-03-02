// Pipes and Obstacles Manager
class PipeManager {
    constructor() {
        this.pipes = [];
        this.coins = [];
        this.powerups = [];
        this.pipesPassed = 0;
        this.spawnTimer = 0;
        this.spawnInterval = 100;
        this.pipeSpeed = 2;
        this.seed = Math.random() * 10000;
    }

    seededRandom(offset = 0) {
        const x = Math.sin(this.seed + offset) * 10000;
        return x - Math.floor(x);
    }

    update(dt = 1) {
        const speedMult = window.gameState && window.gameState.slowMo ? 0.5 : 1;
        this.spawnTimer += dt;

        if (this.spawnTimer >= this.spawnInterval) {
            this.spawnPipe();
            this.spawnTimer = 0;
        }

        // Update pipes
        this.pipes.forEach(pipe => {
            pipe.x -= this.pipeSpeed * dt * speedMult;

            if (pipe.moving) {
                pipe.moveTimer = (pipe.moveTimer || 0) + dt;
                pipe.topHeight += Math.sin(pipe.moveTimer / 20) * 0.5;
            }
        });

        // Update coins
        this.coins.forEach(coin => {
            coin.x -= this.pipeSpeed * dt * speedMult;
            coin.angle = (coin.angle || 0) + 0.1;
        });

        // Update powerups
        this.powerups.forEach(powerup => {
            powerup.x -= this.pipeSpeed * dt * speedMult;
            powerup.angle = (powerup.angle || 0) + 0.05;
        });

        // Remove off-screen objects
        this.pipes = this.pipes.filter(p => p.x > -p.width - 50);
        this.coins = this.coins.filter(c => c.x > -50);
        this.powerups = this.powerups.filter(p => p.x > -50);
    }

    spawnPipe() {
        const gapSize = 150;
        const minHeight = 100;
        const maxHeight = window.GAME_HEIGHT - gapSize - minHeight - 50;
        const topHeight = minHeight + this.seededRandom(this.pipesPassed) * (maxHeight - minHeight);

        const pipe = {
            x: window.GAME_WIDTH,
            topHeight: topHeight,
            gap: gapSize,
            width: 60,
            passed: false,
            burned: false,
            moving: this.seededRandom(this.pipesPassed + 0.5) > 0.7,
            moveTimer: 0
        };

        this.pipes.push(pipe);

        // Spawn coins
        if (this.seededRandom(this.pipesPassed + 0.1) > 0.5) {
            this.spawnCoins(pipe);
        }

        // Spawn powerups (less frequent)
        if (this.seededRandom(this.pipesPassed + 0.2) > 0.85) {
            this.spawnPowerup(pipe);
        }
    }

    spawnCoins(pipe) {
        const coinCount = Math.floor(this.seededRandom(this.pipesPassed + 0.3) * 3) + 2;
        const coinX = pipe.x + pipe.width / 2;
        const gapY = pipe.topHeight + pipe.gap / 2;

        for (let i = 0; i < coinCount; i++) {
            this.coins.push({
                x: coinX + i * 25,
                y: gapY + (i % 2 ? -20 : 20),
                radius: 10,
                collected: false,
                angle: 0
            });
        }
    }

    spawnPowerup(pipe) {
        const types = ['shield', 'fire', 'slowmo', 'magnet', 'ghost', 'tiny'];
        const type = types[Math.floor(this.seededRandom(this.pipesPassed + 0.4) * types.length)];

        this.powerups.push({
            x: pipe.x + pipe.width / 2,
            y: pipe.topHeight + pipe.gap / 2,
            type: type,
            radius: 15,
            collected: false,
            angle: 0
        });
    }

    draw(ctx) {
        // Draw pipes
        this.pipes.forEach(pipe => this.drawPipe(ctx, pipe));

        // Draw coins
        this.coins.forEach(coin => this.drawCoin(ctx, coin));

        // Draw powerups
        this.powerups.forEach(powerup => this.drawPowerup(ctx, powerup));

        // Draw ground
        this.drawGround(ctx);
    }

    drawPipe(ctx, pipe) {
        if (pipe.burned) {
            ctx.globalAlpha = 0.3;
        }

        // Pipe color
        ctx.fillStyle = pipe.moving ? '#FF6B35' : '#44A4A0';
        ctx.strokeStyle = '#2A7B77';
        ctx.lineWidth = 3;

        // Top pipe
        ctx.fillRect(pipe.x, 0, pipe.width, pipe.topHeight);
        ctx.strokeRect(pipe.x, 0, pipe.width, pipe.topHeight);

        // Top cap
        ctx.fillRect(pipe.x - 5, pipe.topHeight - 20, pipe.width + 10, 20);
        ctx.strokeRect(pipe.x - 5, pipe.topHeight - 20, pipe.width + 10, 20);

        // Bottom pipe
        const bottomY = pipe.topHeight + pipe.gap;
        const bottomHeight = window.GAME_HEIGHT - bottomY - 50;
        ctx.fillRect(pipe.x, bottomY, pipe.width, bottomHeight);
        ctx.strokeRect(pipe.x, bottomY, pipe.width, bottomHeight);

        // Bottom cap
        ctx.fillRect(pipe.x - 5, bottomY, pipe.width + 10, 20);
        ctx.strokeRect(pipe.x - 5, bottomY, pipe.width + 10, 20);

        ctx.globalAlpha = 1;
    }

    drawCoin(ctx, coin) {
        if (coin.collected) return;

        ctx.save();
        ctx.translate(coin.x, coin.y);
        ctx.rotate(coin.angle);

        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, coin.radius);
        gradient.addColorStop(0, '#FFD700');
        gradient.addColorStop(0.5, '#FFA500');
        gradient.addColorStop(1, '#FF8C00');

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(0, 0, coin.radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#FF6B35';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('$', 0, 0);

        ctx.restore();
    }

    drawPowerup(ctx, powerup) {
        if (powerup.collected) return;

        const icons = {
            shield: '🛡️',
            fire: '🔥',
            slowmo: '⏱️',
            magnet: '🧲',
            ghost: '👻',
            tiny: '🌀'
        };

        ctx.save();
        ctx.translate(powerup.x, powerup.y);
        ctx.rotate(powerup.angle);

        ctx.fillStyle = 'rgba(78, 205, 196, 0.3)';
        ctx.beginPath();
        ctx.arc(0, 0, powerup.radius + 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#4ECDC4';
        ctx.strokeStyle = '#2A7B77';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, powerup.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.font = '20px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(icons[powerup.type] || '?', 0, 0);

        ctx.restore();
    }

    drawGround(ctx) {
        const groundY = window.GAME_HEIGHT - 50;

        ctx.fillStyle = '#8B4513';
        ctx.fillRect(0, groundY, window.GAME_WIDTH, 50);

        ctx.fillStyle = '#228B22';
        ctx.fillRect(0, groundY, window.GAME_WIDTH, 10);

        // Grass pattern
        ctx.strokeStyle = '#32CD32';
        for (let x = 0; x < window.GAME_WIDTH; x += 20) {
            ctx.beginPath();
            ctx.moveTo(x, groundY);
            ctx.lineTo(x + 5, groundY - 5);
            ctx.moveTo(x + 10, groundY);
            ctx.lineTo(x + 15, groundY - 5);
            ctx.stroke();
        }
    }

    checkBirdCollisions(bird) {
        // Check coin collection
        this.coins.forEach(coin => {
            if (coin.collected) return;

            const dx = bird.x - coin.x;
            const dy = bird.y - coin.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            const collectDistance = bird.magnet ? bird.radius + coin.radius + 30 : bird.radius + coin.radius;

            if (distance < collectDistance) {
                coin.collected = true;
                const coinValue = storage.hasUpgrade('moreCoins') ? 2 : 1;
                if (window.gameState) {
                    gameState.coins += coinValue;
                    gameState.sessionCoins += coinValue;
                }
                if (window.gameAudio) gameAudio.playCoin();
            }
        });

        // Check powerup collection
        this.powerups.forEach(powerup => {
            if (powerup.collected) return;

            const dx = bird.x - powerup.x;
            const dy = bird.y - powerup.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < bird.radius + powerup.radius) {
                powerup.collected = true;
                bird.activatePowerup(powerup.type);
                if (window.gameAudio) gameAudio.playPowerup();
                if (window.gameState) {
                    gameState.showPowerupHUD(powerup.type);
                }
            }
        });

        // Check pipe passing
        this.pipes.forEach(pipe => {
            if (!pipe.passed && bird.x > pipe.x + pipe.width) {
                pipe.passed = true;
                this.pipesPassed++;
                if (window.gameState) {
                    gameState.score++;
                    gameState.checkNearMiss(bird, pipe);
                }
                if (window.gameAudio) gameAudio.playScore();
            }
        });
    }

    reset() {
        this.pipes = [];
        this.coins = [];
        this.powerups = [];
        this.pipesPassed = 0;
        this.spawnTimer = 0;
        this.seed = Math.random() * 10000;
    }

    setSeed(seed) {
        this.seed = seed;
    }
}
