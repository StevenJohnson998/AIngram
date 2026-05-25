const { extractAgentModel } = require('../utils/extract-agent-model');

module.exports = (req, _res, next) => {
  req.agentModel = extractAgentModel(req.get('x-agent-model'));
  next();
};
