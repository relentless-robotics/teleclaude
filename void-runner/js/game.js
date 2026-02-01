// Main Game Class - Spicy Flappy Bird
class Game {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.setupCanvas();

        this.bird = null;
        this.pipeManager = null;
        this.particles = null;
        this.score = 0;
        this.coins = 0;
        this.sessionCoins = 0;
        this.combo = 0;
        this.gameStarted = false;
        this.gameOver = false;
        this.lastTime = 0;
        this.backgroundOffset = 0;
        this.eventTimer = 0;
        this.currentEvent = null;

        this.setupInput();
        this.loop = this.loop.bind(this);
    }

    setupCanvas() {
        window.GAME_WIDTH = this.canvas.width = window.innerWidth;
        window.GAME_HEIGHT = this.canvas.height = window.innerHeight;

        window.addEventListener('resize', () => {
            window.GAME_WIDTH = this.canvas.width = window.innerWidth;
            window.GAME_HEIGHT = this.canvas.height = window.innerHeight;
        });
    }

    setupInput() {
        const flap = () => {
            if (!this.gameStarted) {
                this.gameStarted = true;
            }
            if (this.gameOver) return;
            if (this.bird) this.bird.flap();
        };

        this.canvas.addEventListener('click', flap);
        this.canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            flap();
        });

        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                e.preventDefault();
                flap();
            }
        });
    }

    start() {
        this.reset();
        this.gameStarted = false;
        this.gameOver = false;
        requestAnimationFrame(this.loop);
    }

    reset() {
        const skinId = storage.getSelectedSkin();
        this.bird = new Bird(window.GAME_WIDTH / 4, window.GAME_HEIGHT / 2, skinId);
        this.pipeManager = new PipeManager();
        this.particles = new ParticleSystem();
        this.score = 0;
        this.coins = 0;
        this.sessionCoins = 0;
        this.combo = 0;
        this.eventTimer = 0;
        this.currentEvent = null;
        this.backgroundOffset = 0;
        uiManager.updateHUD(this.score, storage.getCoins());
    }

    loop(timestamp) {
        if (this.gameOver) return;

        const deltaTime = timestamp - this.lastTime;
        this.lastTime = timestamp;

        this.update(deltaTime / 16.67);
        this.draw();

        requestAnimationFrame(this.loop);
    }

    update(dt) {
        if (!this.gameStarted) return;

        // Update bird
        this.bird.update(dt);

        // Update pipes
        this.pipeManager.update(dt);

        // Check collisions
        this.pipeManager.checkBirdCollisions(this.bird);

        // Check death
        if (this.bird.checkCollision(this.pipeManager.pipes)) {
            this.die();
        }

        // Update particles
        this.particles.update();

        // Update background
        this.backgroundOffset -= 1 * dt;

        // Random events
        this.eventTimer += dt;
        if (this.eventTimer > 600 && !this.currentEvent && Math.random() > 0.99) {
            this.triggerRandomEvent();
        }

        // Update score display
        uiManager.updateHUD(this.score, storage.getCoins());

        // Update powerups HUD
        uiManager.updatePowerupsHUD?.(this.bird);

        // Send multiplayer data
        if (window.mpManager && mpManager.connections.length > 0) {
            mpManager.sendPosition(this.bird);
        }
    }

    draw() {
        // Clear
        this.ctx.fillStyle = '#87CEEB';
        this.ctx.fillRect(0, 0, window.GAME_WIDTH, window.GAME_HEIGHT);

        // Draw background
        this.drawBackground();

        // Draw pipes
        this.pipeManager.draw(this.ctx);

        // Draw particles
        this.particles.draw(this.ctx);

        // Draw bird
        this.bird.draw(this.ctx);

        // Draw multiplayer ghosts
        if (window.mpManager) {
            mpManager.drawGhostPlayers(this.ctx);
        }

        // Draw start message
        if (!this.gameStarted) {
            this.ctx.fillStyle = '#000';
            this.ctx.font = 'bold 30px Arial';
            this.ctx.textAlign = 'center';
            this.ctx.fillText('TAP TO START', window.GAME_WIDTH / 2, window.GAME_HEIGHT / 2);
        }
    }

    drawBackground() {
        // Sky gradient
        const gradient = this.ctx.createLinearGradient(0, 0, 0, window.GAME_HEIGHT);
        gradient.addColorStop(0, '#87CEEB');
        gradient.addColorStop(1, '#E0F6FF');
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(0, 0, window.GAME_WIDTH, window.GAME_HEIGHT);

        // Clouds
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        for (let i = 0; i < 5; i++) {
            const x = (this.backgroundOffset + i * 300) % (window.GAME_WIDTH + 100);
            const y = 50 + i * 80;
            this.drawCloud(x, y);
        }
    }

    drawCloud(x, y) {
        this.ctx.beginPath();
        this.ctx.arc(x, y, 30, 0, Math.PI * 2);
        this.ctx.arc(x + 25, y, 35, 0, Math.PI * 2);
        this.ctx.arc(x + 50, y, 30, 0, Math.PI * 2);
        this.ctx.fill();
    }

    die() {
        this.gameOver = true;
        gameAudio.playDeath();

        // Save coins
        storage.addCoins(this.sessionCoins);

        // Save high score
        const isHighScore = storage.setHighScore(this.score);

        // Particles
        this.particles.emit(this.bird.x, this.bird.y, 'rgb(255, 215, 0)', 30);

        // Show game over
        setTimeout(() => {
            uiManager.showGameOver(this.score, this.sessionCoins);
        }, 500);

        // Notify multiplayer
        if (window.mpManager && mpManager.connections.length > 0) {
            mpManager.sendDeath();
        }
    }

    checkNearMiss(bird, pipe) {
        const distanceToTop = Math.abs(bird.y - pipe.topHeight);
        const distanceToBottom = Math.abs(bird.y - (pipe.topHeight + pipe.gap));
        const minDistance = Math.min(distanceToTop, distanceToBottom);

        if (minDistance < 50) {
            this.combo++;
            uiManager.showCombo?.(this.combo);
            this.score += this.combo;
        } else {
            this.combo = 0;
        }
    }

    triggerRandomEvent() {
        const events = [
            { name: '🌋 EARTHQUAKE!', effect: () => this.earthquake() },
            { name: '💨 WIND GUST!', effect: () => this.windGust() },
            { name: '⚡ SPEED UP!', effect: () => this.speedUp() }
        ];

        const event = events[Math.floor(Math.random() * events.length)];
        this.currentEvent = event;
        uiManager.showEventBanner(event.name);
        event.effect();

        setTimeout(() => {
            this.currentEvent = null;
            this.eventTimer = 0;
        }, 3000);
    }

    earthquake() {
        const originalDraw = this.draw.bind(this);
        const shakeAmount = 5;
        let shakeTime = 0;

        const shakeInterval = setInterval(() => {
            this.ctx.save();
            this.ctx.translate(
                (Math.random() - 0.5) * shakeAmount,
                (Math.random() - 0.5) * shakeAmount
            );
            shakeTime++;
            if (shakeTime > 50) {
                clearInterval(shakeInterval);
                this.ctx.restore();
            }
        }, 50);
    }

    windGust() {
        const direction = Math.random() > 0.5 ? 1 : -1;
        let gustTime = 0;
        const gustInterval = setInterval(() => {
            if (this.bird) {
                this.bird.velocity += direction * 0.3;
            }
            gustTime++;
            if (gustTime > 60) {
                clearInterval(gustInterval);
            }
        }, 50);
    }

    speedUp() {
        const originalSpeed = this.pipeManager.pipeSpeed;
        this.pipeManager.pipeSpeed = originalSpeed * 1.5;
        setTimeout(() => {
            this.pipeManager.pipeSpeed = originalSpeed;
        }, 3000);
    }

    setMultiplayerSeed(seed) {
        if (this.pipeManager) {
            this.pipeManager.setSeed(seed);
        }
    }

    showPowerupHUD(type) {
        // Already handled in updatePowerupsHUD
    }
}

// Global game state
window.gameState = null;

// Initialize game when page loads
window.addEventListener('load', () => {
    window.game = new Game();
    window.gameState = game;
    console.log('Spicy Flappy Bird loaded!');
});
