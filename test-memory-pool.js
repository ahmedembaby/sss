const { initDatabase } = require('./db');

async function testMemoryPool() {
  console.log('Testing memory pool...');
  
  try {
    await initDatabase();
    console.log('✅ Database initialized');
    
    const pool = require('./db');
    
    // Test user creation
    console.log('\n🔍 Testing user creation...');
    const sql = `INSERT INTO users (name, email, password) VALUES (?, ?, ?)`;
    const params = ['Test User', 'test@example.com', 'hashedpassword'];
    console.log('Calling pool.query with:', sql, params);
    const userResult = await pool.query(sql, params);
    console.log('User insert result:', userResult);
    
    // Test group creation
    console.log('\n🔍 Testing group creation...');
    const groupResult = await pool.query(
      `INSERT INTO \`groups\` (name, description, type, avatar, created_by, settings) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['Test Group', 'A test group', 'public', null, 1, JSON.stringify({})]
    );
    console.log('Group insert result:', groupResult);
    
    const [groupInsert] = groupResult;
    console.log('Group insertId:', groupInsert.insertId);
    
    // Test group member creation
    console.log('\n🔍 Testing group member creation...');
    const memberResult = await pool.query(
      `INSERT INTO group_members (group_id, user_id, role, status) VALUES (?, ?, ?, ?)`,
      [groupInsert.insertId, 1, 'owner', 'active']
    );
    console.log('Member insert result:', memberResult);
    
    // Test group fetch
    console.log('\n🔍 Testing group fetch...');
    const groupFetch = await pool.query(
      `SELECT g.*, u.name as creator_name, u.avatar as creator_avatar
       FROM \`groups\` g
       LEFT JOIN users u ON u.id = g.created_by
       WHERE g.id = ?`,
      [groupInsert.insertId]
    );
    console.log('Group fetch result:', groupFetch);
    const [group] = groupFetch;
    console.log('Group:', group);
    
    // Test user groups list
    console.log('\n🔍 Testing user groups list...');
    const groupsList = await pool.query(
      `SELECT g.*, gm.role, gm.status as member_status,
              (SELECT COUNT(*) FROM group_members WHERE group_id = g.id AND status = 'active') as member_count
       FROM \`groups\` g
       INNER JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = ? AND gm.status IN ('active', 'pending')
       ORDER BY g.created_at DESC
       LIMIT ? OFFSET ?`,
      [1, 20, 0]
    );
    console.log('Groups list result:', groupsList);
    
    console.log('\n✅ All tests passed!');
  } catch (err) {
    console.error('🔴 Test failed:', err);
    console.error(err.stack);
  }
}

testMemoryPool();