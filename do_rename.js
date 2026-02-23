const fs = require('fs');
const path = require('path');

const excludeDirs = ['node_modules', '.git', 'dist', 'build', 'assets'];
const targetExtensions = ['.js', '.ts', '.tsx', '.json', '.html', '.css', '.md', '.yml', '.yaml'];

function replaceInFile(filePath) {
    try {
        let content = fs.readFileSync(filePath, 'utf8');
        let original = content;

        // ChordVox -> ChordVox
        content = content.replace(/ChordVox/g, 'ChordVox');
        content = content.replace(/chordvox/g, 'chordvox');
        content = content.replace(/CHORDVOX/g, 'CHORDVOX');
        content = content.replace(/Chordvox/g, 'Chordvox');

        // Replace trigger phrases
        content = content.replace(/Hey \$\{agentName\}/g, 'Hi ${agentName}');
        content = content.replace(/Hey \{\{agentName\}\}/g, 'Hi {{agentName}}');
        content = content.replace(/Hey \{\{name\}\}/g, 'Hi {{name}}');
        content = content.replace(/Hi ChordVox/gi, 'Hi ChordVox');

        if (content !== original) {
            fs.writeFileSync(filePath, content, 'utf8');
            console.log('Updated', filePath);
        }
    } catch (err) {
        if (err.code !== 'EISDIR') {
            console.error(`Error reading ${filePath}:`, err.message);
        }
    }
}

function processDirectory(dir) {
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            if (excludeDirs.includes(file)) continue;

            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                processDirectory(fullPath);
            } else {
                const ext = path.extname(fullPath);
                if (targetExtensions.includes(ext) || file === '.env.example' || file.startsWith('.')) {
                    // Double check it's not a binary
                    if (stat.size < 5000000) { // Limit to 5MB
                        replaceInFile(fullPath);
                    }
                }
            }
        }
    } catch (err) {
        console.error(`Error processing directory ${dir}:`, err.message);
    }
}

processDirectory(process.argv[2] || '.');
console.log('Done');
