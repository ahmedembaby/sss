const { createMemoryPool } = require('./db');

async function testMemoryPoolDirect() {
  console.log('Testing memory pool directly...');
  
  const memPool = createMemoryPool();
  
  // Test group creation
  console.log('\n🔍 Testing group creation...');
  const sql = `INSERT INTO \`groups\` (name, description, type, avatar, created_by, settings) VALUES (?, ?, ?, ?, ?, ?)`;
  const params = ['Test Group', 'A test group', 'public', null, 1, JSON.stringify({})];
  console.log('Calling memPool.query with:', sql, params);
  
  try {
    const result = await memPool.query(sql, params);
    console.log('Group insert result:', result);
  } catch (err) {
    console.error('Error:', err);
  }
}

testMemoryPoolDirect();