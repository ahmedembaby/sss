const sql = `INSERT INTO \`groups\` (name, description, type, avatar, created_by, settings) VALUES (?, ?, ?, ?, ?, ?)`;
const normalizedSql = sql.trim().toLowerCase();
console.log('Normalized SQL:', normalizedSql);
console.log('Includes into `groups`:', normalizedSql.includes('into `groups`'));
console.log('Includes into groups:', normalizedSql.includes('into groups'));
console.log('Starts with insert:', normalizedSql.startsWith('insert'));