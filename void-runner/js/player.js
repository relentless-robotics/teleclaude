// Player Ship Controller
class Player {
    constructor(scene) {
        this.scene = scene;
        this.mesh = null;
        this.lane = 1; // 0=left, 1=center, 2=right
        this.laneWidth = 3;
        this.targetX = 0;
        this.velocity = { x: 0, y: 0, z: 0 };
        this.isJumping = false;
        this.isDucking = false;
        this.lives = 3;
        this.invincible = false;
        this.invincibleTime = 0;

        // Touch controls
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.swipeThreshold = 50;

        // Tilt controls
        this.tiltEnabled = false;
        this.tiltSensitivity = 0.5;

        this.createMesh();
        this.setupControls();
    }

    createMesh() {
        // Create neon ship with enhanced visuals
        const geometry = new THREE.Group();

        // Main body with emissive glow
        const bodyGeometry = new THREE.BoxGeometry(0.8, 0.4, 1.2);
        const bodyMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            transparent: true,
            opacity: 0.9
        });
        const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
        geometry.add(body);

        // Wings with neon edges
        const wingGeometry = new THREE.BoxGeometry(2, 0.1, 0.6);
        const wingMaterial = new THREE.MeshBasicMaterial({
            color: 0xff00ff,
            transparent: true,
            opacity: 0.95
        });
        const wings = new THREE.Mesh(wingGeometry, wingMaterial);
        wings.position.y = -0.2;
        geometry.add(wings);

        // Cockpit glow
        const glowGeometry = new THREE.SphereGeometry(0.3, 8, 8);
        const glowMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.7
        });
        const glow = new THREE.Mesh(glowGeometry, glowMaterial);
        glow.position.z = 0.3;
        geometry.add(glow);

        // Engine glow points (back of ship)
        const engineGlowGeometry = new THREE.SphereGeometry(0.15, 8, 8);
        const engineGlowMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            transparent: true,
            opacity: 0.8
        });

        const leftEngine = new THREE.Mesh(engineGlowGeometry, engineGlowMaterial);
        leftEngine.position.set(-0.6, 0, -0.6);
        geometry.add(leftEngine);

        const rightEngine = new THREE.Mesh(engineGlowGeometry, engineGlowMaterial);
        rightEngine.position.set(0.6, 0, -0.6);
        geometry.add(rightEngine);

        // Add point lights for better glow effect
        const mainLight = new THREE.PointLight(0x00ffff, 1.5, 8);
        geometry.add(mainLight);

        const leftEngineLight = new THREE.PointLight(0x00ffff, 0.8, 4);
        leftEngineLight.position.set(-0.6, 0, -0.6);
        geometry.add(leftEngineLight);

        const rightEngineLight = new THREE.PointLight(0x00ffff, 0.8, 4);
        rightEngineLight.position.set(0.6, 0, -0.6);
        geometry.add(rightEngineLight);

        // Create engine trail particles
        this.createEngineParticles();

        geometry.position.set(0, 1, -5);
        this.mesh = geometry;
        this.scene.add(geometry);
    }

    createEngineParticles() {
        // Engine trail particle system
        const particleCount = 50;
        const particles = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const velocities = [];
        const lifetimes = [];

        for (let i = 0; i < particleCount; i++) {
            positions[i * 3] = 0;
            positions[i * 3 + 1] = 0;
            positions[i * 3 + 2] = 0;
            velocities.push({ x: 0, y: 0, z: 0, active: false, age: 0 });
            lifetimes.push(0);
        }

        particles.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const particleMaterial = new THREE.PointsMaterial({
            color: 0x00ffff,
            size: 0.15,
            transparent: true,
            opacity: 0.7,
            blending: THREE.AdditiveBlending
        });

        this.engineParticles = new THREE.Points(particles, particleMaterial);
        this.particleVelocities = velocities;
        this.particleIndex = 0;
        this.particleSpawnTimer = 0;

        this.scene.add(this.engineParticles);
    }

    updateEngineParticles(deltaTime) {
        if (!this.engineParticles) return;

        const positions = this.engineParticles.geometry.attributes.position.array;

        // Spawn new particles
        this.particleSpawnTimer += deltaTime;
        if (this.particleSpawnTimer > 0.02) { // Spawn every 20ms
            this.particleSpawnTimer = 0;

            // Spawn from left engine
            const leftIdx = this.particleIndex;
            positions[leftIdx * 3] = this.mesh.position.x - 0.6;
            positions[leftIdx * 3 + 1] = this.mesh.position.y;
            positions[leftIdx * 3 + 2] = this.mesh.position.z - 0.6;
            this.particleVelocities[leftIdx] = {
                x: (Math.random() - 0.5) * 0.5,
                y: (Math.random() - 0.5) * 0.3,
                z: Math.random() * 2 + 1,
                active: true,
                age: 0
            };

            this.particleIndex = (this.particleIndex + 1) % this.particleVelocities.length;

            // Spawn from right engine
            const rightIdx = this.particleIndex;
            positions[rightIdx * 3] = this.mesh.position.x + 0.6;
            positions[rightIdx * 3 + 1] = this.mesh.position.y;
            positions[rightIdx * 3 + 2] = this.mesh.position.z - 0.6;
            this.particleVelocities[rightIdx] = {
                x: (Math.random() - 0.5) * 0.5,
                y: (Math.random() - 0.5) * 0.3,
                z: Math.random() * 2 + 1,
                active: true,
                age: 0
            };

            this.particleIndex = (this.particleIndex + 1) % this.particleVelocities.length;
        }

        // Update all particles
        for (let i = 0; i < this.particleVelocities.length; i++) {
            const vel = this.particleVelocities[i];
            if (vel.active) {
                positions[i * 3] += vel.x * deltaTime * 10;
                positions[i * 3 + 1] += vel.y * deltaTime * 10;
                positions[i * 3 + 2] += vel.z * deltaTime * 10;

                vel.age += deltaTime;
                if (vel.age > 0.5) { // Particle lifetime
                    vel.active = false;
                    positions[i * 3 + 2] = 1000; // Move far away
                }
            }
        }

        this.engineParticles.geometry.attributes.position.needsUpdate = true;
    }

    setupControls() {
        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft' || e.key === 'a') this.moveLeft();
            if (e.key === 'ArrowRight' || e.key === 'd') this.moveRight();
            if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ') this.jump();
            if (e.key === 'ArrowDown' || e.key === 's') this.duck();
        });

        document.addEventListener('keyup', (e) => {
            if (e.key === 'ArrowDown' || e.key === 's') this.unduck();
        });

        // Touch controls
        const canvas = document.getElementById('gameCanvas');

        canvas.addEventListener('touchstart', (e) => {
            this.touchStartX = e.touches[0].clientX;
            this.touchStartY = e.touches[0].clientY;
        });

        canvas.addEventListener('touchend', (e) => {
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const deltaX = touchEndX - this.touchStartX;
            const deltaY = touchEndY - this.touchStartY;

            // Determine swipe direction
            if (Math.abs(deltaX) > Math.abs(deltaY)) {
                // Horizontal swipe
                if (Math.abs(deltaX) > this.swipeThreshold) {
                    if (deltaX > 0) this.moveRight();
                    else this.moveLeft();
                }
            } else {
                // Vertical swipe
                if (Math.abs(deltaY) > this.swipeThreshold) {
                    if (deltaY < 0) this.jump();
                    else {
                        this.duck();
                        setTimeout(() => this.unduck(), 500);
                    }
                }
            }
        });

        // Tilt controls (optional)
        if (window.DeviceOrientationEvent) {
            window.addEventListener('deviceorientation', (e) => {
                if (this.tiltEnabled && e.gamma) {
                    // gamma is left-right tilt (-90 to 90)
                    const tilt = Math.max(-30, Math.min(30, e.gamma)) / 30;
                    if (Math.abs(tilt) > 0.3) {
                        this.targetX = tilt * this.laneWidth * this.tiltSensitivity;
                    }
                }
            });
        }
    }

    moveLeft() {
        if (this.lane > 0) {
            this.lane--;
            this.targetX = (this.lane - 1) * this.laneWidth;
            Audio.play('jump', 300, 0.05);
        }
    }

    moveRight() {
        if (this.lane < 2) {
            this.lane++;
            this.targetX = (this.lane - 1) * this.laneWidth;
            Audio.play('jump', 300, 0.05);
        }
    }

    jump() {
        if (!this.isJumping && !this.isDucking) {
            this.isJumping = true;
            this.velocity.y = 8;
            Audio.play('jump');
        }
    }

    duck() {
        if (!this.isJumping) {
            this.isDucking = true;
            this.mesh.scale.y = 0.5;
        }
    }

    unduck() {
        this.isDucking = false;
        this.mesh.scale.y = 1;
    }

    hit() {
        if (this.invincible) return false;

        this.lives--;
        Audio.play('hit');

        if (this.lives > 0) {
            // Temporary invincibility
            this.invincible = true;
            this.invincibleTime = 2; // 2 seconds

            // Flash effect
            let flashCount = 0;
            const flashInterval = setInterval(() => {
                this.mesh.visible = !this.mesh.visible;
                flashCount++;
                if (flashCount > 10) {
                    clearInterval(flashInterval);
                    this.mesh.visible = true;
                }
            }, 200);

            return false;
        }

        return true; // Game over
    }

    addLife() {
        this.lives = Math.min(this.lives + 1, 5);
    }

    update(deltaTime) {
        // Smooth lane movement
        const lerpSpeed = 10 * deltaTime;
        const xDiff = this.targetX - this.mesh.position.x;
        this.mesh.position.x += xDiff * lerpSpeed;

        // Jump physics
        if (this.isJumping) {
            this.velocity.y -= 25 * deltaTime; // Gravity
            this.mesh.position.y += this.velocity.y * deltaTime;

            if (this.mesh.position.y <= 1) {
                this.mesh.position.y = 1;
                this.isJumping = false;
                this.velocity.y = 0;
            }
        }

        // Invincibility timer
        if (this.invincible) {
            this.invincibleTime -= deltaTime;
            if (this.invincibleTime <= 0) {
                this.invincible = false;
            }
        }

        // Bobbing animation
        if (!this.isJumping) {
            this.mesh.position.y = 1 + Math.sin(Date.now() * 0.003) * 0.1;
        }

        // Banking rotation based on movement (like a real ship)
        const targetRotationZ = -xDiff * 0.5;
        this.mesh.rotation.z += (targetRotationZ - this.mesh.rotation.z) * 5 * deltaTime;

        // Tilt forward slightly
        this.mesh.rotation.x = -0.1;

        // Update engine particles
        this.updateEngineParticles(deltaTime);
    }

    reset() {
        this.lane = 1;
        this.targetX = 0;
        this.mesh.position.set(0, 1, -5);
        this.velocity = { x: 0, y: 0, z: 0 };
        this.isJumping = false;
        this.isDucking = false;
        this.lives = 3;
        this.invincible = false;
        this.mesh.scale.y = 1;
    }

    setTiltEnabled(enabled) {
        this.tiltEnabled = enabled;
    }
}
