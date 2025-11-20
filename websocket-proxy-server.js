// UNUSUAL WHALES WEBSOCKET PROXY SERVER
// Connects to UW WebSocket, filters signals, forwards to n8n
// Deploy to Railway.app (free tier)

const WebSocket = require('ws');
const express = require('express');
const axios = require('axios');

// ============================================
// CONFIGURATION
// ============================================

const UW_API_KEY = 'efde1afc-7def-4638-9f13-701b87a0086f';
const N8N_WEBHOOK_URL = 'https://ndrozd6261.app.n8n.cloud/webhook/uw-live-signal'; // Update this after deploying n8n workflow

// Unusual Whales WebSocket endpoint
// Check their docs for exact URL - common patterns:
// wss://api.unusualwhales.com/v1/ws
// wss://ws.unusualwhales.com/stream
const WS_URL = 'wss://api.unusualwhales.com/v1/ws';

const PORT = process.env.PORT || 3000;

// ============================================
// TIER 1 SYMBOLS (Only trade these)
// ============================================

const TIER_1 = new Set([
  'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA',
  'BRK.B', 'V', 'UNH', 'JNJ', 'WMT', 'XOM', 'LLY', 'JPM', 'MA', 'PG',
  'AVGO', 'HD', 'CVX', 'MRK', 'ABBV', 'KO', 'PEP', 'COST', 'BAC',
  'TMO', 'ADBE', 'CRM', 'NFLX', 'DIS', 'AMD', 'NKE', 'CSCO', 'ABT',
  'CMCSA', 'VZ', 'DHR', 'INTC', 'PFE', 'TXN', 'ORCL', 'WFC', 'PM',
  'RTX', 'UPS', 'T', 'IBM', 'QCOM'
]);

// ============================================
// FILTERING THRESHOLDS
// ============================================

const MIN_PREMIUM = 1000000; // $1M minimum
const MIN_DARK_POOL = 500000; // $500K minimum
const MIN_PRIORITY = 7; // Only send signals with priority >= 7

// ============================================
// STATE TRACKING
// ============================================

let ws = null;
let reconnectAttempts = 0;
let isConnected = false;
let stats = {
  messagesReceived: 0,
  signalsSent: 0,
  errors: 0,
  startTime: new Date()
};

// Multi-factor confirmation tracking
const recentSignals = {}; // symbol -> [signals]
const CONFIRMATION_WINDOW = 300000; // 5 minutes

// ============================================
// EXPRESS SERVER (Health checks & monitoring)
// ============================================

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    connected: isConnected,
    stats: {
      ...stats,
      uptime: Math.floor((Date.now() - stats.startTime) / 1000) + 's'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: isConnected ? 'healthy' : 'disconnected',
    connected: isConnected
  });
});

app.listen(PORT, () => {
  console.log(`✅ Proxy server running on port ${PORT}`);
  connectWebSocket();
});

// ============================================
// WEBSOCKET CONNECTION
// ============================================

function connectWebSocket() {
  console.log('🔌 Connecting to Unusual Whales WebSocket...');
  
  try {
    // Create WebSocket connection with authentication
    ws = new WebSocket(WS_URL, {
      headers: {
        'Authorization': `Bearer ${UW_API_KEY}`
      }
    });
    
    ws.on('open', handleOpen);
    ws.on('message', handleMessage);
    ws.on('close', handleClose);
    ws.on('error', handleError);
    ws.on('pong', () => {
      console.log('📡 Pong received');
    });
    
  } catch (error) {
    console.error('❌ WebSocket connection error:', error);
    scheduleReconnect();
  }
}

function handleOpen() {
  console.log('✅ Connected to Unusual Whales WebSocket');
  isConnected = true;
  reconnectAttempts = 0;
  
  // Subscribe to channels
  const subscribeMessage = {
    action: 'subscribe',
    channels: [
      'flow', // Options flow
      'darkpool', // Dark pool prints
      'tide' // Market tide
    ]
  };
  
  ws.send(JSON.stringify(subscribeMessage));
  console.log('📡 Subscribed to channels:', subscribeMessage.channels);
  
  // Start heartbeat
  startHeartbeat();
}

function handleMessage(data) {
  stats.messagesReceived++;
  
  try {
    const message = JSON.parse(data.toString());
    
    // Route to appropriate handler
    if (message.type === 'flow' || message.channel === 'flow') {
      processOptionsFlow(message.data || message);
    } else if (message.type === 'darkpool' || message.channel === 'darkpool') {
      processDarkPool(message.data || message);
    } else if (message.type === 'tide' || message.channel === 'tide') {
      processMarketTide(message.data || message);
    } else if (message.type === 'pong' || message.event === 'pong') {
      // Heartbeat response
    } else {
      console.log('📨 Unknown message type:', message.type || message.event);
    }
    
  } catch (error) {
    console.error('❌ Error parsing message:', error);
    stats.errors++;
  }
}

function handleClose(code, reason) {
  console.log(`❌ WebSocket closed: ${code} - ${reason}`);
  isConnected = false;
  stopHeartbeat();
  scheduleReconnect();
}

function handleError(error) {
  console.error('❌ WebSocket error:', error);
  stats.errors++;
}

// ============================================
// HEARTBEAT (Keep connection alive)
// ============================================

let heartbeatInterval = null;

function startHeartbeat() {
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log('💓 Ping sent');
    }
  }, 30000); // Every 30 seconds
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ============================================
// RECONNECTION LOGIC
// ============================================

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 60000); // Max 60s
  
  console.log(`🔄 Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts})...`);
  
  setTimeout(() => {
    connectWebSocket();
  }, delay);
}

// ============================================
// SIGNAL PROCESSING
// ============================================

function processOptionsFlow(data) {
  const ticker = data.ticker || data.symbol;
  
  // Filter: Tier 1 only
  if (!TIER_1.has(ticker)) return;
  
  const premium = data.premium || 0;
  const volume = data.volume || 0;
  
  // Filter: High premium only
  if (premium < MIN_PREMIUM) return;
  
  // Calculate priority
  const priority = premium > 5000000 ? 10 : premium > 2000000 ? 9 : 8;
  
  // Filter: High priority only
  if (priority < MIN_PRIORITY) return;
  
  const signal = {
    type: 'HIGH_PREMIUM_FLOW',
    symbol: ticker,
    side: data.call_put || data.type,
    premium: premium,
    volume: volume,
    strike: data.strike,
    expiry: data.expiry || data.expiration_date,
    timestamp: new Date().toISOString(),
    action: (data.call_put === 'CALL' || data.type === 'call') ? 'BUY_CALLS' : 'BUY_PUTS',
    reason: `$${(premium/1000000).toFixed(2)}M premium flow detected LIVE`,
    priority: priority,
    source: 'UNUSUAL_WHALES_LIVE',
    rawData: data
  };
  
  console.log(`🚨 HIGH PREMIUM: ${signal.symbol} ${signal.side} $${(premium/1000000).toFixed(2)}M`);\n  
  trackSignal(signal);
  sendToN8N(signal);
}

function processDarkPool(data) {
  const ticker = data.ticker || data.symbol;
  
  // Filter: Tier 1 only
  if (!TIER_1.has(ticker)) return;
  
  const size = data.size || 0;
  const price = data.price || 0;
  const value = size * price;
  
  // Filter: Large prints only
  if (value < MIN_DARK_POOL) return;
  
  // Calculate priority
  const priority = value > 2000000 ? 10 : value > 1000000 ? 9 : 8;
  
  // Filter: High priority only
  if (priority < MIN_PRIORITY) return;
  
  const avgPrice = data.average_price || data.avg_price || price;
  const sentiment = price > avgPrice ? 'BULLISH' : 'BEARISH';
  
  const signal = {
    type: 'DARK_POOL_PRINT',
    symbol: ticker,
    size: size,
    price: price,
    value: value,
    sentiment: sentiment,
    timestamp: new Date().toISOString(),
    action: sentiment === 'BULLISH' ? 'BUY_CALLS' : 'BUY_PUTS',
    reason: `$${(value/1000000).toFixed(2)}M dark pool ${sentiment} LIVE`,
    priority: priority,
    source: 'UNUSUAL_WHALES_LIVE',
    rawData: data
  };
  
  console.log(`🐋 DARK POOL: ${signal.symbol} $${(value/1000000).toFixed(2)}M ${sentiment}`);
  
  trackSignal(signal);
  sendToN8N(signal);
}

function processMarketTide(data) {
  const putCallRatio = data.put_call_ratio || data.pcRatio || 0;
  
  let signal = null;
  
  // EXTREME FEAR
  if (putCallRatio > 1.2) {
    signal = {
      type: 'MARKET_SENTIMENT',
      sentiment: 'EXTREME_FEAR',
      putCallRatio: putCallRatio,
      timestamp: new Date().toISOString(),
      action: 'CONSIDER_CALLS',
      reason: `Put/Call ratio ${putCallRatio.toFixed(2)} - market oversold`,
      priority: 8,
      source: 'UNUSUAL_WHALES_LIVE',
      rawData: data
    };
  } 
  // EXTREME GREED
  else if (putCallRatio < 0.6) {
    signal = {
      type: 'MARKET_SENTIMENT',
      sentiment: 'EXTREME_GREED',
      putCallRatio: putCallRatio,
      timestamp: new Date().toISOString(),
      action: 'CONSIDER_PUTS',
      reason: `Put/Call ratio ${putCallRatio.toFixed(2)} - market overbought`,
      priority: 8,
      source: 'UNUSUAL_WHALES_LIVE',
      rawData: data
    };
  }
  
  if (signal) {
    console.log(`📊 MARKET TIDE: ${signal.sentiment} (P/C: ${putCallRatio.toFixed(2)})`);\n    sendToN8N(signal);
  }
}

// ============================================
// MULTI-FACTOR CONFIRMATION
// ============================================

function trackSignal(signal) {
  const symbol = signal.symbol;
  const now = Date.now();
  
  // Initialize tracking for this symbol
  if (!recentSignals[symbol]) {
    recentSignals[symbol] = [];
  }
  
  // Add this signal
  recentSignals[symbol].push({
    ...signal,
    receivedAt: now
  });
  
  // Remove old signals (outside confirmation window)
  recentSignals[symbol] = recentSignals[symbol].filter(
    s => now - s.receivedAt < CONFIRMATION_WINDOW
  );
  
  // Check for multi-factor confirmation
  if (recentSignals[symbol].length >= 2) {
    const signals = recentSignals[symbol];
    
    // Count bullish vs bearish
    const bullish = signals.filter(s => 
      s.action.includes('CALL') || s.sentiment === 'BULLISH'
    ).length;
    
    const bearish = signals.filter(s => 
      s.action.includes('PUT') || s.sentiment === 'BEARISH'
    ).length;
    
    // Calculate average priority
    const avgPriority = signals.reduce((sum, s) => sum + s.priority, 0) / signals.length;
    
    // Create multi-factor confirmation signal
    const confirmationSignal = {
      type: 'MULTI_FACTOR_CONFIRMATION',
      symbol: symbol,
      direction: bullish > bearish ? 'BULLISH' : 'BEARISH',
      signalCount: signals.length,
      bullishSignals: bullish,
      bearishSignals: bearish,
      avgPriority: Math.round(avgPriority),
      timestamp: new Date().toISOString(),
      action: bullish > bearish ? 'BUY_CALLS' : 'BUY_PUTS',
      reason: `${signals.length} confirming signals (${bullish} bullish, ${bearish} bearish)`,
      priority: Math.min(10, Math.round(avgPriority) + 2), // Boost priority
      source: 'UNUSUAL_WHALES_LIVE',
      underlyingSignals: signals
    };
    
    console.log(`✅ CONFIRMED: ${symbol} ${confirmationSignal.direction} (${signals.length} signals)`);
    
    // Send confirmation signal
    sendToN8N(confirmationSignal);
    
    // Clear tracked signals for this symbol (avoid duplicates)
    recentSignals[symbol] = [];
  }
}

// ============================================
// SEND TO N8N
// ============================================

async function sendToN8N(signal) {
  if (!N8N_WEBHOOK_URL || N8N_WEBHOOK_URL === 'YOUR_N8N_WEBHOOK_URL_HERE') {
    console.warn('⚠️ N8N webhook URL not configured');
    return;
  }
  
  try {
    const response = await axios.post(N8N_WEBHOOK_URL, signal, {
      timeout: 3000 // 3 second timeout
    });
    
    stats.signalsSent++;
    console.log(`✅ Signal sent to n8n: ${signal.type} ${signal.symbol || ''}`);
    
  } catch (error) {
    console.error('❌ Error sending to n8n:', error.message);
    stats.errors++;
  }
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  stopHeartbeat();
  if (ws) {
    ws.close();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  stopHeartbeat();
  if (ws) {
    ws.close();
  }
  process.exit(0);
});

console.log('🚀 Unusual Whales WebSocket Proxy Server starting...');
