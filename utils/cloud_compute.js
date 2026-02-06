/**
 * Cloud Compute Provider Integration
 *
 * Unified interface for managing compute resources across cloud providers:
 * - AWS EC2
 * - Google Cloud Compute Engine
 * - DigitalOcean Droplets
 * - Vast.ai (GPU instances)
 * - RunPod (GPU instances)
 *
 * All providers use the same interface for launching/managing instances.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'cloud_providers.json');
const INSTANCES_FILE = path.join(__dirname, '..', 'config', 'cloud_instances.json');

// Default config template
const DEFAULT_CONFIG = {
    providers: {
        aws: {
            enabled: false,
            region: 'us-east-1',
            credentials: {
                accessKeyId: '',
                secretAccessKey: ''
            }
        },
        gcp: {
            enabled: false,
            projectId: '',
            region: 'us-central1',
            credentialsFile: ''
        },
        digitalocean: {
            enabled: false,
            apiToken: ''
        },
        vastai: {
            enabled: false,
            apiKey: ''
        },
        runpod: {
            enabled: false,
            apiKey: ''
        }
    },
    defaultSSHKey: '',
    instanceNaming: 'teleclaude-{provider}-{timestamp}'
};

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return DEFAULT_CONFIG;
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadInstances() {
    if (fs.existsSync(INSTANCES_FILE)) {
        return JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
    }
    return { instances: [] };
}

function saveInstances(instances) {
    fs.writeFileSync(INSTANCES_FILE, JSON.stringify(instances, null, 2));
}

/**
 * Instance specification presets for different workloads
 */
const INSTANCE_PRESETS = {
    // CPU-only instances
    'cpu-small': {
        aws: { type: 't3.small', vcpu: 2, ram: 2 },
        gcp: { type: 'e2-small', vcpu: 2, ram: 2 },
        digitalocean: { size: 's-1vcpu-2gb' }
    },
    'cpu-medium': {
        aws: { type: 't3.medium', vcpu: 2, ram: 4 },
        gcp: { type: 'e2-medium', vcpu: 2, ram: 4 },
        digitalocean: { size: 's-2vcpu-4gb' }
    },
    'cpu-large': {
        aws: { type: 't3.xlarge', vcpu: 4, ram: 16 },
        gcp: { type: 'e2-standard-4', vcpu: 4, ram: 16 },
        digitalocean: { size: 's-4vcpu-8gb' }
    },
    'cpu-xlarge': {
        aws: { type: 't3.2xlarge', vcpu: 8, ram: 32 },
        gcp: { type: 'e2-standard-8', vcpu: 8, ram: 32 },
        digitalocean: { size: 's-8vcpu-16gb' }
    },

    // GPU instances
    'gpu-small': {
        aws: { type: 'g4dn.xlarge', vcpu: 4, ram: 16, gpu: 'T4' },
        gcp: { type: 'n1-standard-4', vcpu: 4, ram: 15, gpu: 'nvidia-tesla-t4' },
        vastai: { gpu_name: 'RTX 3080', num_gpus: 1 },
        runpod: { gpuTypeId: 'NVIDIA RTX 3080', gpuCount: 1 }
    },
    'gpu-medium': {
        aws: { type: 'g4dn.2xlarge', vcpu: 8, ram: 32, gpu: 'T4' },
        gcp: { type: 'n1-standard-8', vcpu: 8, ram: 30, gpu: 'nvidia-tesla-t4' },
        vastai: { gpu_name: 'RTX 3090', num_gpus: 1 },
        runpod: { gpuTypeId: 'NVIDIA RTX 3090', gpuCount: 1 }
    },
    'gpu-large': {
        aws: { type: 'p3.2xlarge', vcpu: 8, ram: 61, gpu: 'V100' },
        gcp: { type: 'n1-standard-8', vcpu: 8, ram: 30, gpu: 'nvidia-tesla-v100' },
        vastai: { gpu_name: 'RTX 4090', num_gpus: 1 },
        runpod: { gpuTypeId: 'NVIDIA RTX 4090', gpuCount: 1 }
    },
    'gpu-xlarge': {
        aws: { type: 'p3.8xlarge', vcpu: 32, ram: 244, gpu: 'V100x4' },
        vastai: { gpu_name: 'A100', num_gpus: 1 },
        runpod: { gpuTypeId: 'NVIDIA A100 80GB', gpuCount: 1 }
    }
};

/**
 * AWS EC2 Provider
 */
const awsProvider = {
    name: 'aws',

    async launch(preset, options = {}) {
        const config = loadConfig();
        if (!config.providers.aws.enabled) {
            return { success: false, error: 'AWS not configured' };
        }

        const spec = INSTANCE_PRESETS[preset]?.aws;
        if (!spec) {
            return { success: false, error: `Unknown preset: ${preset}` };
        }

        const { name, userData, securityGroup, keyName } = options;
        const instanceName = name || `teleclaude-aws-${Date.now()}`;

        try {
            // Use AWS CLI
            const args = [
                'aws', 'ec2', 'run-instances',
                '--image-id', options.imageId || 'ami-0c7217cdde317cfec', // Ubuntu 22.04
                '--instance-type', spec.type,
                '--key-name', keyName || config.providers.aws.keyName,
                '--tag-specifications', `ResourceType=instance,Tags=[{Key=Name,Value=${instanceName}}]`,
                '--query', 'Instances[0].InstanceId',
                '--output', 'text'
            ];

            if (securityGroup) args.push('--security-group-ids', securityGroup);
            if (userData) args.push('--user-data', userData);

            const instanceId = execSync(args.join(' '), { encoding: 'utf8' }).trim();

            // Wait for running state
            execSync(`aws ec2 wait instance-running --instance-ids ${instanceId}`);

            // Get public IP
            const publicIp = execSync(
                `aws ec2 describe-instances --instance-ids ${instanceId} --query 'Reservations[0].Instances[0].PublicIpAddress' --output text`,
                { encoding: 'utf8' }
            ).trim();

            const instance = {
                provider: 'aws',
                instanceId,
                name: instanceName,
                type: spec.type,
                publicIp,
                preset,
                launchedAt: new Date().toISOString()
            };

            // Save to instances file
            const instances = loadInstances();
            instances.instances.push(instance);
            saveInstances(instances);

            return { success: true, instance };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    async terminate(instanceId) {
        try {
            execSync(`aws ec2 terminate-instances --instance-ids ${instanceId}`);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    async list() {
        try {
            const output = execSync(
                `aws ec2 describe-instances --filters "Name=tag:Name,Values=teleclaude-*" --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==\`Name\`].Value|[0],State.Name,PublicIpAddress,InstanceType]' --output json`,
                { encoding: 'utf8' }
            );
            return { success: true, instances: JSON.parse(output) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
};

/**
 * Vast.ai Provider (GPU rentals)
 */
const vastaiProvider = {
    name: 'vastai',

    async search(requirements = {}) {
        const config = loadConfig();
        if (!config.providers.vastai.enabled) {
            return { success: false, error: 'Vast.ai not configured' };
        }

        const { gpu = 'RTX 3090', minVram = 8, maxPrice = 1.0 } = requirements;

        try {
            // Use Vast.ai CLI
            const output = execSync(
                `vastai search offers "gpu_name==${gpu} gpu_ram>=${minVram} dph<=${maxPrice}" --raw`,
                { encoding: 'utf8' }
            );
            return { success: true, offers: JSON.parse(output) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    async launch(offerId, options = {}) {
        const config = loadConfig();
        if (!config.providers.vastai.enabled) {
            return { success: false, error: 'Vast.ai not configured' };
        }

        const { image = 'pytorch/pytorch:2.0.0-cuda11.7-cudnn8-runtime', disk = 20 } = options;

        try {
            const output = execSync(
                `vastai create instance ${offerId} --image ${image} --disk ${disk} --raw`,
                { encoding: 'utf8' }
            );
            const result = JSON.parse(output);

            const instance = {
                provider: 'vastai',
                instanceId: result.new_contract,
                offerId,
                image,
                launchedAt: new Date().toISOString()
            };

            const instances = loadInstances();
            instances.instances.push(instance);
            saveInstances(instances);

            return { success: true, instance };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    async terminate(instanceId) {
        try {
            execSync(`vastai destroy instance ${instanceId}`);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    async list() {
        try {
            const output = execSync('vastai show instances --raw', { encoding: 'utf8' });
            return { success: true, instances: JSON.parse(output) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
};

/**
 * RunPod Provider (GPU rentals)
 */
const runpodProvider = {
    name: 'runpod',

    async apiRequest(endpoint, method = 'GET', data = null) {
        const config = loadConfig();
        if (!config.providers.runpod.apiKey) {
            throw new Error('RunPod API key not configured');
        }

        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.runpod.io',
                path: `/graphql`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.providers.runpod.apiKey}`
                }
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });

            req.on('error', reject);
            if (data) req.write(JSON.stringify(data));
            req.end();
        });
    },

    async getGpuTypes() {
        const query = `
            query {
                gpuTypes {
                    id
                    displayName
                    memoryInGb
                    secureCloud
                    communityCloud
                }
            }
        `;
        return this.apiRequest(null, 'POST', { query });
    },

    async launch(preset, options = {}) {
        const config = loadConfig();
        if (!config.providers.runpod.enabled) {
            return { success: false, error: 'RunPod not configured' };
        }

        const spec = INSTANCE_PRESETS[preset]?.runpod;
        if (!spec) {
            return { success: false, error: `Unknown preset: ${preset}` };
        }

        const {
            name = `teleclaude-runpod-${Date.now()}`,
            image = 'runpod/pytorch:2.0.0-py3.10-cuda11.8.0-devel',
            volumeInGb = 20
        } = options;

        const query = `
            mutation {
                podFindAndDeployOnDemand(
                    input: {
                        name: "${name}"
                        imageName: "${image}"
                        gpuTypeId: "${spec.gpuTypeId}"
                        gpuCount: ${spec.gpuCount || 1}
                        volumeInGb: ${volumeInGb}
                        containerDiskInGb: 20
                    }
                ) {
                    id
                    imageName
                    gpuCount
                    costPerHr
                }
            }
        `;

        try {
            const result = await this.apiRequest(null, 'POST', { query });

            if (result.errors) {
                return { success: false, error: result.errors[0].message };
            }

            const pod = result.data.podFindAndDeployOnDemand;
            const instance = {
                provider: 'runpod',
                instanceId: pod.id,
                name,
                image,
                gpuCount: pod.gpuCount,
                costPerHr: pod.costPerHr,
                preset,
                launchedAt: new Date().toISOString()
            };

            const instances = loadInstances();
            instances.instances.push(instance);
            saveInstances(instances);

            return { success: true, instance };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    async terminate(podId) {
        const query = `
            mutation {
                podTerminate(input: { podId: "${podId}" })
            }
        `;

        try {
            await this.apiRequest(null, 'POST', { query });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    async list() {
        const query = `
            query {
                myself {
                    pods {
                        id
                        name
                        desiredStatus
                        imageName
                        gpuCount
                        costPerHr
                    }
                }
            }
        `;

        try {
            const result = await this.apiRequest(null, 'POST', { query });
            return { success: true, instances: result.data.myself.pods };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
};

/**
 * Unified Cloud Compute Interface
 */
const cloudCompute = {
    providers: {
        aws: awsProvider,
        vastai: vastaiProvider,
        runpod: runpodProvider
    },

    /**
     * Launch instance on specified provider
     */
    async launch(provider, preset, options = {}) {
        const p = this.providers[provider];
        if (!p) {
            return { success: false, error: `Unknown provider: ${provider}` };
        }
        return p.launch(preset, options);
    },

    /**
     * Find cheapest option across providers for a given preset
     */
    async findCheapest(preset, providers = ['vastai', 'runpod']) {
        const results = [];

        for (const providerName of providers) {
            const provider = this.providers[providerName];
            if (!provider) continue;

            try {
                if (providerName === 'vastai') {
                    const spec = INSTANCE_PRESETS[preset]?.vastai;
                    if (spec) {
                        const offers = await provider.search({
                            gpu: spec.gpu_name,
                            minVram: 8,
                            maxPrice: 2.0
                        });
                        if (offers.success && offers.offers.length > 0) {
                            const cheapest = offers.offers.sort((a, b) => a.dph_total - b.dph_total)[0];
                            results.push({
                                provider: 'vastai',
                                pricePerHour: cheapest.dph_total,
                                gpu: cheapest.gpu_name,
                                offerId: cheapest.id
                            });
                        }
                    }
                } else if (providerName === 'runpod') {
                    // RunPod pricing would need API call
                    const spec = INSTANCE_PRESETS[preset]?.runpod;
                    if (spec) {
                        results.push({
                            provider: 'runpod',
                            pricePerHour: 'varies', // Would need API call
                            gpu: spec.gpuTypeId
                        });
                    }
                }
            } catch (error) {
                console.error(`Error checking ${providerName}:`, error.message);
            }
        }

        results.sort((a, b) => {
            if (typeof a.pricePerHour === 'number' && typeof b.pricePerHour === 'number') {
                return a.pricePerHour - b.pricePerHour;
            }
            return 0;
        });

        return results;
    },

    /**
     * Terminate instance
     */
    async terminate(provider, instanceId) {
        const p = this.providers[provider];
        if (!p) {
            return { success: false, error: `Unknown provider: ${provider}` };
        }
        return p.terminate(instanceId);
    },

    /**
     * List all instances across all providers
     */
    async listAll() {
        const config = loadConfig();
        const allInstances = [];

        for (const [name, provider] of Object.entries(this.providers)) {
            if (config.providers[name]?.enabled) {
                try {
                    const result = await provider.list();
                    if (result.success) {
                        allInstances.push({
                            provider: name,
                            instances: result.instances
                        });
                    }
                } catch (error) {
                    console.error(`Error listing ${name}:`, error.message);
                }
            }
        }

        return allInstances;
    },

    /**
     * Get estimated costs for running a preset for X hours
     */
    estimateCost(preset, hours, provider = 'aws') {
        // Rough cost estimates per hour
        const costs = {
            aws: {
                'cpu-small': 0.02,
                'cpu-medium': 0.04,
                'cpu-large': 0.17,
                'cpu-xlarge': 0.33,
                'gpu-small': 0.53,
                'gpu-medium': 0.75,
                'gpu-large': 3.06,
                'gpu-xlarge': 12.24
            },
            vastai: {
                'gpu-small': 0.20,
                'gpu-medium': 0.30,
                'gpu-large': 0.80,
                'gpu-xlarge': 1.50
            },
            runpod: {
                'gpu-small': 0.25,
                'gpu-medium': 0.35,
                'gpu-large': 1.00,
                'gpu-xlarge': 2.00
            }
        };

        const hourlyRate = costs[provider]?.[preset] || 0;
        return {
            provider,
            preset,
            hours,
            hourlyRate,
            totalCost: (hourlyRate * hours).toFixed(2)
        };
    },

    /**
     * Configure a provider
     */
    configureProvider(provider, settings) {
        const config = loadConfig();
        if (!config.providers[provider]) {
            config.providers[provider] = {};
        }
        Object.assign(config.providers[provider], settings, { enabled: true });
        saveConfig(config);
        return { success: true };
    },

    /**
     * Get configuration status
     */
    getStatus() {
        const config = loadConfig();
        const status = {};

        for (const [name, settings] of Object.entries(config.providers)) {
            status[name] = {
                enabled: settings.enabled || false,
                configured: Boolean(
                    (name === 'aws' && settings.credentials?.accessKeyId) ||
                    (name === 'gcp' && settings.projectId) ||
                    (name === 'digitalocean' && settings.apiToken) ||
                    (name === 'vastai' && settings.apiKey) ||
                    (name === 'runpod' && settings.apiKey)
                )
            };
        }

        return status;
    },

    // Export presets for reference
    INSTANCE_PRESETS
};

module.exports = cloudCompute;

// CLI interface
if (require.main === module) {
    const args = process.argv.slice(2);
    const cmd = args[0];

    (async () => {
        switch (cmd) {
            case 'status':
                console.log('Cloud Provider Status:');
                console.log(JSON.stringify(cloudCompute.getStatus(), null, 2));
                break;

            case 'presets':
                console.log('Available Instance Presets:');
                for (const [name, specs] of Object.entries(INSTANCE_PRESETS)) {
                    console.log(`\n${name}:`);
                    for (const [provider, spec] of Object.entries(specs)) {
                        console.log(`  ${provider}: ${JSON.stringify(spec)}`);
                    }
                }
                break;

            case 'estimate':
                const preset = args[1] || 'gpu-medium';
                const hours = parseInt(args[2]) || 8;
                console.log('Cost Estimates:');
                ['aws', 'vastai', 'runpod'].forEach(p => {
                    const est = cloudCompute.estimateCost(preset, hours, p);
                    console.log(`  ${p}: $${est.totalCost} for ${hours}h (${preset})`);
                });
                break;

            case 'list':
                const instances = await cloudCompute.listAll();
                console.log('Running Instances:');
                console.log(JSON.stringify(instances, null, 2));
                break;

            default:
                console.log('Cloud Compute Manager');
                console.log('Usage:');
                console.log('  node cloud_compute.js status    - Show provider configuration status');
                console.log('  node cloud_compute.js presets   - List available instance presets');
                console.log('  node cloud_compute.js estimate [preset] [hours] - Estimate costs');
                console.log('  node cloud_compute.js list      - List all running instances');
        }
    })();
}
