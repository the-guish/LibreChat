const { createSharedLinkAccessMiddleware } = require('@librechat/api');
const db = require('~/models');

const canAccessSharedLink = createSharedLinkAccessMiddleware({ db });

module.exports = canAccessSharedLink;
