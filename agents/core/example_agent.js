/**
 * Example Agent Implementation
 *
 * Demonstrates how to create a custom agent using RedisAgent base class
 */

const { RedisAgent, RedisOrchestrator, initialize } = require('./index');

/**
 * Example Trading Agent
 *
 * Processes trading-related tasks
 */
class TradingAgent extends RedisAgent {
  constructor(name = 'trading-agent') {
    super(name, {
      capabilities: {
        type: 'trading',
        markets: ['stocks', 'crypto'],
        actions: ['buy', 'sell', 'analyze']
      },
      autoStart: true,
      taskTimeout: 60000 // 1 minute timeout
    });
  }

  /**
   * Process a trading task
   * @override
   */
  async processTask(task) {
    console.log(`Processing ${task.type} task:`, task);

    switch (task.type) {
      case 'analyze':
        return await this.analyzeMarket(task.data);

      case 'buy':
        return await this.executeBuy(task.data);

      case 'sell':
        return await this.executeSell(task.data);

      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }
  }

  /**
   * Analyze market data
   */
  async analyzeMarket(data) {
    console.log('Analyzing market:', data);

    // Simulate analysis
    await new Promise(resolve => setTimeout(resolve, 1000));

    const analysis = {
      symbol: data.symbol,
      price: Math.random() * 1000,
      trend: Math.random() > 0.5 ? 'bullish' : 'bearish',
      recommendation: Math.random() > 0.5 ? 'buy' : 'sell'
    };

    await this.sendAlert('info', `Analysis complete for ${data.symbol}`, analysis);

    return analysis;
  }

  /**
   * Execute buy order
   */
  async executeBuy(data) {
    console.log('Executing buy order:', data);

    // Simulate order execution
    await new Promise(resolve => setTimeout(resolve, 500));

    const order = {
      orderId: `order_${Date.now()}`,
      symbol: data.symbol,
      quantity: data.quantity,
      price: data.price || Math.random() * 1000,
      status: 'filled',
      timestamp: Date.now()
    };

    await this.sendAlert('info', `Buy order filled: ${data.symbol}`, order);

    return order;
  }

  /**
   * Execute sell order
   */
  async executeSell(data) {
    console.log('Executing sell order:', data);

    // Simulate order execution
    await new Promise(resolve => setTimeout(resolve, 500));

    const order = {
      orderId: `order_${Date.now()}`,
      symbol: data.symbol,
      quantity: data.quantity,
      price: data.price || Math.random() * 1000,
      status: 'filled',
      timestamp: Date.now()
    };

    await this.sendAlert('info', `Sell order filled: ${data.symbol}`, order);

    return order;
  }

  /**
   * Handle incoming message
   * @override
   */
  onMessage(message) {
    console.log('Trading agent received message:', message);

    if (message.type === 'price_update') {
      console.log(`Price update: ${message.symbol} = $${message.price}`);
    }
  }

  /**
   * Handle broadcast
   * @override
   */
  onBroadcast(message) {
    console.log('Trading agent received broadcast:', message);

    if (message.type === 'market_alert') {
      console.log(`Market alert: ${message.message}`);
    }
  }
}

/**
 * Example Data Agent
 *
 * Processes data analysis tasks
 */
class DataAgent extends RedisAgent {
  constructor(name = 'data-agent') {
    super(name, {
      capabilities: {
        type: 'data',
        formats: ['csv', 'json', 'sql'],
        operations: ['transform', 'aggregate', 'export']
      },
      autoStart: true
    });
  }

  async processTask(task) {
    console.log(`Processing ${task.type} task:`, task);

    // Simulate data processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    return {
      processed: true,
      rows: Math.floor(Math.random() * 10000),
      duration: 2000
    };
  }
}

/**
 * Demo: Run multiple agents with orchestrator
 */
async function runDemo() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║    Multi-Agent System Demo            ║');
  console.log('╚════════════════════════════════════════╝\n');

  // Initialize system
  const { orchestrator } = await initialize({ startOrchestrator: true });

  // Create and start agents
  const tradingAgent = new TradingAgent();
  const dataAgent = new DataAgent();

  await tradingAgent.start();
  await dataAgent.start();

  console.log('\n✓ Agents started\n');

  // Register callbacks
  orchestrator.onAlert((alert) => {
    console.log(`[ORCHESTRATOR] Alert from ${alert.agentName}: ${alert.message}`);
  });

  orchestrator.onResult((data) => {
    console.log(`[ORCHESTRATOR] Task ${data.taskId} completed by ${data.agentName}`);
  });

  // Delegate tasks
  console.log('Delegating tasks...\n');

  const tasks = [
    orchestrator.delegateTask('trading-agent', {
      type: 'analyze',
      data: { symbol: 'AAPL' }
    }),
    orchestrator.delegateTask('trading-agent', {
      type: 'buy',
      data: { symbol: 'TSLA', quantity: 10, price: 250 }
    }),
    orchestrator.delegateTask('data-agent', {
      type: 'transform',
      data: { file: 'data.csv' }
    })
  ];

  await Promise.all(tasks);
  console.log('\n✓ All tasks delegated\n');

  // Wait for tasks to complete
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Get system status
  const status = await orchestrator.getSystemStatus();
  console.log('\nSystem Status:');
  console.log(JSON.stringify(status, null, 2));

  // Broadcast a message
  await orchestrator.broadcast({
    type: 'market_alert',
    message: 'Market volatility detected'
  });

  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Cleanup
  console.log('\nShutting down...\n');
  await tradingAgent.stop();
  await dataAgent.stop();
  await orchestrator.stop();

  console.log('✓ Demo complete\n');
  process.exit(0);
}

// Run demo if executed directly
if (require.main === module) {
  runDemo().catch(error => {
    console.error('Demo failed:', error);
    process.exit(1);
  });
}

module.exports = { TradingAgent, DataAgent };
