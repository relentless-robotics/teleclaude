// Bird Class - Player Character
class Bird {
    constructor(x, y, skinId = 'classic') {
        this.x = x;
        this.y = y;
        this.velocity = 0;
        this.gravity = 0.5;
        this.jump = -9;
        this.rotation = 0;
        this.radius = 15;
        this.skinId = skinId;
        this.trail = [];
        this.animFrame = 0;
        this.flapAnimTimer = 0;

        // Power-ups
        this.shield = false;
        this.fireMode = false;
        this.firePipesLeft = 0;
        this.slowMo = false;
        this.magnet = false;
        this.ghost = false;
        this.tiny = false;

        // Upgrades
        if (storage.hasUpgrade('smallerHitbox')) {
            this.radius = 12;
        }

        if (storage.hasUpgrade('startingShield')) {
            this.shield = true;
        }
    }

    flap() {
        this.velocity = this.jump;
        this.flapAnimTimer = 10;
        if (window.gameAudio) gameAudio.playFlap();
    }

    update(dt = 1) {
        const gravityMultiplier = this.slowMo ? 0.5 : 1;
        this.velocity += this.gravity * dt * gravityMultiplier;
        this.y += this.velocity * dt;

        // Rotation based on velocity
        this.rotation = Math.max(-30, Math.min(60, this.velocity * 3));

        // Animate flap
        if (this.flapAnimTimer > 0) {
            this.flapAnimTimer--;
        }
        this.animFrame = (this.animFrame + 0.2) % 3;

        // Trail effect
        if (this.shouldHaveTrail()) {
            this.trail.push({ x: this.x, y: this.y, life: 20 });
        }

        this.trail = this.trail.filter(t => t.life-- > 0);
    }

    draw(ctx) {
        ctx.save();

        // Draw trail
        this.drawTrail(ctx);

        // Draw main bird
        ctx.translate(this.x, this.y);
        ctx.rotate((this.rotation * Math.PI) / 180);

        this.drawBirdSkin(ctx);

        // Draw shield
        if (this.shield) {
            ctx.strokeStyle = '#4ECDC4';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(0, 0, this.radius + 5, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Draw effects
        if (this.fireMode) {
            ctx.fillStyle = 'rgba(255,100,0,0.5)';
            ctx.beginPath();
            ctx.arc(0, 0, this.radius + 8, 0, Math.PI * 2);
            ctx.fill();
        }

        if (this.ghost) {
            ctx.globalAlpha = 0.5;
        }

        ctx.restore();
    }

    drawBirdSkin(ctx) {
        const skins = {
            classic: () => this.drawClassic(ctx),
            phoenix: () => this.drawPhoenix(ctx),
            ice: () => this.drawIce(ctx),
            rainbow: () => this.drawRainbow(ctx),
            golden: () => this.drawGolden(ctx),
            skeleton: () => this.drawSkeleton(ctx),
            robot: () => this.drawRobot(ctx),
            unicorn: () => this.drawUnicorn(ctx)
        };

        (skins[this.skinId] || skins.classic)();
    }

    drawClassic(ctx) {
        // Yellow bird
        ctx.fillStyle = '#FFD700';
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.fill();

        // Wing
        const wingOffset = this.flapAnimTimer > 0 ? -5 : 0;
        ctx.fillStyle = '#FFA500';
        ctx.beginPath();
        ctx.ellipse(-5, wingOffset, 8, 5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Eye
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(5, -5, 3, 0, Math.PI * 2);
        ctx.fill();

        // Beak
        ctx.fillStyle = '#FF6B35';
        ctx.beginPath();
        ctx.moveTo(10, 0);
        ctx.lineTo(18, -3);
        ctx.lineTo(18, 3);
        ctx.closePath();
        ctx.fill();
    }

    drawPhoenix(ctx) {
        ctx.fillStyle = '#FF4500';
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#FFD700';
        ctx.beginPath();
        ctx.arc(0, 0, this.radius - 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(5, -5, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    drawIce(ctx) {
        ctx.fillStyle = '#87CEEB';
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#FFF';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(5, -5, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    drawRainbow(ctx) {
        const colors = ['#FF0000', '#FF7F00', '#FFFF00', '#00FF00', '#0000FF', '#4B0082', '#9400D3'];
        const hue = (Date.now() / 10) % 360;
        ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(5, -5, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    drawGolden(ctx) {
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius);
        gradient.addColorStop(0, '#FFD700');
        gradient.addColorStop(1, '#FFA500');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.fill();

        // Sparkle
        if (Math.random() > 0.8) {
            ctx.fillStyle = '#FFF';
            const sx = (Math.random() - 0.5) * this.radius * 2;
            const sy = (Math.random() - 0.5) * this.radius * 2;
            ctx.fillRect(sx, sy, 3, 3);
        }

        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(5, -5, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    drawSkeleton(ctx) {
        ctx.strokeStyle = '#FFF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(5, -5, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#FFF';
        ctx.beginPath();
        ctx.arc(5, -5, 4, 0, Math.PI * 2);
        ctx.stroke();
    }

    drawRobot(ctx) {
        ctx.fillStyle = '#888';
        ctx.fillRect(-this.radius, -this.radius, this.radius * 2, this.radius * 2);

        ctx.fillStyle = '#0FF';
        ctx.fillRect(-5, -5, 4, 4);
        ctx.fillRect(5, -5, 4, 4);

        ctx.strokeStyle = '#FFF';
        ctx.lineWidth = 2;
        ctx.strokeRect(-this.radius, -this.radius, this.radius * 2, this.radius * 2);
    }

    drawUnicorn(ctx) {
        ctx.fillStyle = '#FFB6C1';
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.fill();

        // Horn
        ctx.fillStyle = '#FFD700';
        ctx.beginPath();
        ctx.moveTo(0, -this.radius);
        ctx.lineTo(-3, -this.radius - 10);
        ctx.lineTo(3, -this.radius - 10);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(5, -5, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    drawTrail(ctx) {
        this.trail.forEach((t, i) => {
            const alpha = t.life / 20;
            ctx.fillStyle = this.getTrailColor(alpha);
            ctx.beginPath();
            ctx.arc(t.x, t.y, this.radius * 0.5 * alpha, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    getTrailColor(alpha) {
        if (this.skinId === 'phoenix') return `rgba(255, 69, 0, ${alpha})`;
        if (this.skinId === 'ice') return `rgba(135, 206, 235, ${alpha})`;
        if (this.skinId === 'rainbow') {
            const hue = (Date.now() / 10) % 360;
            return `hsla(${hue}, 100%, 50%, ${alpha})`;
        }
        return `rgba(255, 215, 0, ${alpha})`;
    }

    shouldHaveTrail() {
        return ['phoenix', 'ice', 'rainbow', 'golden'].includes(this.skinId);
    }

    checkCollision(pipes) {
        if (this.ghost) return false;

        // Check ground and ceiling
        if (this.y - this.radius < 0 || this.y + this.radius > window.GAME_HEIGHT - 50) {
            return true;
        }

        // Check pipes
        for (let pipe of pipes) {
            if (this.collidesWithPipe(pipe)) {
                if (this.fireMode && this.firePipesLeft > 0) {
                    pipe.burned = true;
                    this.firePipesLeft--;
                    return false;
                }
                if (this.shield) {
                    this.shield = false;
                    if (window.gameAudio) gameAudio.playHit();
                    return false;
                }
                return true;
            }
        }

        return false;
    }

    collidesWithPipe(pipe) {
        const actualRadius = this.tiny ? this.radius * 0.7 : this.radius;

        if (this.x + actualRadius > pipe.x && this.x - actualRadius < pipe.x + pipe.width) {
            if (this.y - actualRadius < pipe.topHeight || this.y + actualRadius > pipe.topHeight + pipe.gap) {
                return true;
            }
        }
        return false;
    }

    activatePowerup(type) {
        const duration = storage.hasUpgrade('longerPowerups') ? 7500 : 5000;

        switch(type) {
            case 'shield':
                this.shield = true;
                break;
            case 'fire':
                this.fireMode = true;
                this.firePipesLeft = 3;
                setTimeout(() => this.fireMode = false, duration);
                break;
            case 'slowmo':
                this.slowMo = true;
                setTimeout(() => this.slowMo = false, duration);
                break;
            case 'magnet':
                this.magnet = true;
                setTimeout(() => this.magnet = false, duration);
                break;
            case 'ghost':
                this.ghost = true;
                setTimeout(() => this.ghost = false, 3000);
                break;
            case 'tiny':
                this.tiny = true;
                setTimeout(() => this.tiny = false, duration);
                break;
        }
    }
}
