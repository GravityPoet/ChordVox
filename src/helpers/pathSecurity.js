const path = require("path");

function isPathInside(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function resolveInsideDirectory(rootDir, relativePath, label = "path") {
  const rawPath = String(relativePath || "").trim();
  const normalizedRelativePath = rawPath.replace(/^[/\\]+/, "");

  if (!normalizedRelativePath) {
    throw new Error(`Invalid empty ${label}`);
  }

  if (path.isAbsolute(rawPath) || normalizedRelativePath.split(/[\\/]+/).includes("..")) {
    throw new Error(`Unsafe ${label}: ${relativePath}`);
  }

  const resolvedPath = path.resolve(rootDir, normalizedRelativePath);
  if (!isPathInside(rootDir, resolvedPath)) {
    throw new Error(`Unsafe ${label}: ${relativePath}`);
  }

  return resolvedPath;
}

module.exports = {
  isPathInside,
  resolveInsideDirectory,
};
