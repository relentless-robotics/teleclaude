// Obstacle Generator and Manager
class ObstacleManager {
    constructor(scene, player, seed = null) {
        this.scene = scene;
        this.player = player;
        this.obstacles = [];
        this.spawnDistance = 100;
        this.lastSpawnZ = 0;
        this.difficulty = 1;
        this.speed = 20;
        this.laneWidth = 3;

        // Obstacle types
        this.types = ['wall', 'barrier', 'laser', 'gap'];

        // Seeded RNG for multiplayer
        this.rng = seed !== null ? new SeededRandom(seed) : null;
    }

    random() {
        return this.rng ? this.rng.next() : Math.random();
    }

    spawn() {
        const zPos = this.lastSpawnZ - this.spawnDistance;
        const obstacleType = this.types[Math.floor(this.random() * this.types.length)];
        const pattern = this.generatePattern();

        pattern.forEach(lane => {
            const obstacle = this.createObstacle(obstacleType, lane, zPos);
            if (obstacle) {
                this.obstacles.push(obstacle);
                this.scene.add(obstacle);
            }
        });

        this.lastSpawnZ = zPos;
    }

    generatePattern() {
        // Generate lane pattern (which lanes have obstacles)
        const difficulty = Math.min(this.difficulty, 3);
        const numObstacles = Math.floor(this.random() * difficulty) + 1;

        const lanes = [0, 1, 2];
        const pattern = [];

        // Always leave at least one lane clear
        const clearLane = Math.floor(this.random() * 3);

        for (let i = 0; i < numObstacles && pattern.length < 2; i++) {
            const lane = lanes[Math.floor(this.random() * lanes.length)];
            if (lane !== clearLane && !pattern.includes(lane)) {
                pattern.push(lane);
            }
        }

        return pattern;
    }

    createObstacle(type, lane, z) {
        const x = (lane - 1) * this.laneWidth;
        let mesh;

        switch(type) {
            case 'wall':
                mesh = this.createWall(x, z);
                break;
            case 'barrier':
                mesh = this.createBarrier(x, z);
                break;
            case 'laser':
                mesh = this.createLaser(x, z);
                break;
            case 'gap':
                mesh = this.createGap(x, z);
                break;
        }

        if (mesh) {
            mesh.userData = {
                type,
                lane,
                obstacle: true,
                canJumpOver: type === 'barrier',
                canDuckUnder: type === 'laser'
            };
        }

        return mesh;
    }

    createWall(x, z) {
        const geometry = new THREE.BoxGeometry(2, 3, 0.5);
        const material = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            transparent: true,
            opacity: 0.8
        });
        const wall = new THREE.Mesh(geometry, material);
        wall.position.set(x, 1.5, z);

        // Add edge glow
        const edges = new THREE.EdgesGeometry(geometry);
        const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xff00ff });
        const edgeLines = new THREE.LineSegments(edges, edgeMaterial);
        wall.add(edgeLines);

        return wall;
    }

    createBarrier(x, z) {
        const geometry = new THREE.BoxGeometry(2, 1.5, 0.3);
        const material = new THREE.MeshBasicMaterial({
            color: 0xffff00,
            transparent: true,
            opacity: 0.7
        });
        const barrier = new THREE.Mesh(geometry, material);
        barrier.position.set(x, 0.75, z);

        const edges = new THREE.EdgesGeometry(geometry);
        const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xff00ff });
        const edgeLines = new THREE.LineSegments(edges, edgeMaterial);
        barrier.add(edgeLines);

        return barrier;
    }

    createLaser(x, z) {
        const geometry = new THREE.BoxGeometry(2, 0.2, 0.2);
        const material = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            transparent: true,
            opacity: 0.9
        });
        const laser = new THREE.Mesh(geometry, material);
        laser.position.set(x, 2, z);

        // Add glow
        const glowGeometry = new THREE.BoxGeometry(2, 0.4, 0.4);
        const glowMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            transparent: true,
            opacity: 0.3
        });
        const glow = new THREE.Mesh(glowGeometry, glowMaterial);
        laser.add(glow);

        return laser;
    }

    createGap(x, z) {
        // Visual indicator for gap (missing floor section)
        const geometry = new THREE.BoxGeometry(2, 0.1, 5);
        const material = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            transparent: true,
            opacity: 0.3
        });
        const gap = new THREE.Mesh(geometry, material);
        gap.position.set(x, 0, z);

        return gap;
    }

    checkCollisions() {
        const playerBox = new THREE.Box3().setFromObject(this.player.mesh);

        for (let i = this.obstacles.length - 1; i >= 0; i--) {
            const obstacle = this.obstacles[i];
            const obstacleBox = new THREE.Box3().setFromObject(obstacle);

            if (playerBox.intersectsBox(obstacleBox)) {
                const data = obstacle.userData;

                // Check if player can avoid
                let hit = true;

                if (data.canJumpOver && this.player.isJumping && this.player.mesh.position.y > 2) {
                    hit = false;
                }

                if (data.canDuckUnder && this.player.isDucking) {
                    hit = false;
                }

                if (hit) {
                    return true;
                }
            }
        }

        return false;
    }

    update(deltaTime, distance) {
        // Update difficulty based on distance
        this.difficulty = 1 + Math.floor(distance / 500);
        this.speed = 20 + (this.difficulty * 2);

        // Move obstacles
        for (let i = this.obstacles.length - 1; i >= 0; i--) {
            const obstacle = this.obstacles[i];
            obstacle.position.z += this.speed * deltaTime;

            // Remove obstacles that passed the player
            if (obstacle.position.z > 10) {
                this.scene.remove(obstacle);
                this.obstacles.splice(i, 1);
            }

            // Animate obstacles
            obstacle.rotation.y += deltaTime;
        }

        // Spawn new obstacles
        if (this.lastSpawnZ > -200) {
            this.spawn();
        }
    }

    reset() {
        // Remove all obstacles
        this.obstacles.forEach(obstacle => {
            this.scene.remove(obstacle);
        });
        this.obstacles = [];
        this.lastSpawnZ = 0;
        this.difficulty = 1;
        this.speed = 20;
    }

    getNearMissDistance() {
        let minDistance = Infinity;

        for (const obstacle of this.obstacles) {
            if (obstacle.position.z > this.player.mesh.position.z &&
                obstacle.position.z < this.player.mesh.position.z + 3) {
                const distance = Math.abs(obstacle.position.x - this.player.mesh.position.x);
                if (distance < minDistance) {
                    minDistance = distance;
                }
            }
        }

        return minDistance < 2 ? minDistance : null;
    }
}

// Boss System
class Boss {
    constructor(scene, player) {
        this.scene = scene;
        this.player = player;
        this.mesh = null;
        this.active = false;
        this.health = 3;
        this.attackTimer = 0;
        this.projectiles = [];
    }

    spawn() {
        if (this.active) return;

        Audio.play('boss');

        // Show warning
        const warning = document.getElementById('bossWarning');
        warning.style.animation = 'none';
        setTimeout(() => {
            warning.style.animation = 'bossWarning 3s';
        }, 10);

        // Create boss mesh
        const geometry = new THREE.Group();

        const bodyGeometry = new THREE.BoxGeometry(4, 4, 2);
        const bodyMaterial = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            transparent: true,
            opacity: 0.8
        });
        const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
        geometry.add(body);

        // Boss eyes
        const eyeGeometry = new THREE.SphereGeometry(0.5, 8, 8);
        const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });

        const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
        leftEye.position.set(-1, 0.5, 1);
        geometry.add(leftEye);

        const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
        rightEye.position.set(1, 0.5, 1);
        geometry.add(rightEye);

        // Add light
        const light = new THREE.PointLight(0xff0000, 2, 10);
        geometry.add(light);

        geometry.position.set(0, 3, -30);
        this.mesh = geometry;
        this.scene.add(geometry);

        this.active = true;
        this.health = 3;
        this.attackTimer = 2;
    }

    attack() {
        // Launch projectile
        const geometry = new THREE.SphereGeometry(0.3, 8, 8);
        const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const projectile = new THREE.Mesh(geometry, material);

        projectile.position.copy(this.mesh.position);
        projectile.userData = { speed: 15, obstacle: true };

        this.projectiles.push(projectile);
        this.scene.add(projectile);

        Audio.play('hit', 200, 0.15);
    }

    checkHit() {
        const playerBox = new THREE.Box3().setFromObject(this.player.mesh);

        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const proj = this.projectiles[i];
            const projBox = new THREE.Box3().setFromObject(proj);

            if (playerBox.intersectsBox(projBox)) {
                this.scene.remove(proj);
                this.projectiles.splice(i, 1);
                return true;
            }
        }

        return false;
    }

    update(deltaTime) {
        if (!this.active) return;

        // Move boss forward slowly
        this.mesh.position.z += 5 * deltaTime;

        // Sway left/right
        this.mesh.position.x = Math.sin(Date.now() * 0.001) * 4;

        // Attack periodically
        this.attackTimer -= deltaTime;
        if (this.attackTimer <= 0) {
            this.attack();
            this.attackTimer = 2;
        }

        // Update projectiles
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const proj = this.projectiles[i];
            proj.position.z += proj.userData.speed * deltaTime;

            if (proj.position.z > 10) {
                this.scene.remove(proj);
                this.projectiles.splice(i, 1);
            }
        }

        // Boss defeated if it passes player
        if (this.mesh.position.z > 20) {
            this.defeat();
        }

        // Rotate
        this.mesh.rotation.y += deltaTime * 0.5;
    }

    defeat() {
        this.scene.remove(this.mesh);
        this.projectiles.forEach(proj => this.scene.remove(proj));
        this.projectiles = [];
        this.active = false;
        Audio.play('powerup');
        return 500; // Bonus crystals
    }

    reset() {
        if (this.mesh) this.scene.remove(this.mesh);
        this.projectiles.forEach(proj => this.scene.remove(proj));
        this.projectiles = [];
        this.active = false;
    }
}
