'use strict';

const config      = require('./config');
const login       = require('connect-ensure-login');
const oauth2orize = require('oauth2orize');
const passport    = require('passport');
const utils       = require('./utils');

const db          = require(`./${config.db.type}`); // eslint-disable-line

// create OAuth 2.0 server
const server = oauth2orize.createServer();

// Register supported grant types.
//
// OAuth 2.0 specifies a framework that allows users to grant client
// applications limited access to their protected resources.  It does this
// through a process of the user granting access, and the client exchanging
// the grant for an access token.

/**
 * Grant authorization codes
 *
 * The callback takes the `client` requesting authorization, the `redirectURI`
 * (which is used as a verifier in the subsequent exchange), the authenticated
 * `user` granting access, and their response, which contains approved scope,
 * duration, etc. as parsed by the application.  The application issues a code,
 * which is bound to these values, and will be exchanged for an access token.
 */
server.grant(oauth2orize.grant.code((client, redirectURI, user, ares, done) => {
  const code = utils.uid(config.token.authorizationCodeLength);
  db.authorizationCodes.save(code, client.id, redirectURI, user.id, client.scope, (err) => {
    if (err) {
      return done(err);
    }
    return done(null, code);
  });
}));

/**
 * Grant implicit authorization.
 *
 * The callback takes the `client` requesting authorization, the authenticated
 * `user` granting access, and their response, which contains approved scope,
 * duration, etc. as parsed by the application.  The application issues a token,
 * which is bound to these values.
 */
server.grant(oauth2orize.grant.token((client, user, ares, done) => {
  const token      = utils.uid(config.token.accessTokenLength);
  const expiration = config.token.calculateExpirationDate();
  db.accessTokens.save(token, expiration, user.id, client.id, client.scope, (err) => {
    if (err) {
      return done(err);
    }
    return done(null, token, { expires_in: config.token.expiresIn });
  });
}));

/**
 * Exchange authorization codes for access tokens.
 *
 * The callback accepts the `client`, which is exchanging `code` and any
 * `redirectURI` from the authorization request for verification.  If these values
 * are validated, the application issues an access token on behalf of the user who
 * authorized the code.
 */
server.exchange(oauth2orize.exchange.code((client, code, redirectURI, done) => {
  db.authorizationCodes.find(code, (err, authCode) => {
    if (err) {
      return done(err);
    }
    if (!authCode) {
      return done(null, false);
    }
    if (client.id !== authCode.clientID) {
      return done(null, false);
    }
    if (redirectURI !== authCode.redirectURI) {
      return done(null, false);
    }
    return db.authorizationCodes.delete(code, (delErr, result) => {
      if (delErr) {
        return done(delErr);
      }
      if (result != null && result === 0) {
        // This condition can result because of a "race condition" that can occur naturally when
        // you're making two very fast calls to the authorization server to exchange authorization
        // codes.  So, we check for the result and if it's not undefined and the result is zero,
        // then we have already deleted the authorization code
        return done(null, false);
      }
      const token      = utils.uid(config.token.accessTokenLength);
      const expiration = config.token.calculateExpirationDate();
      return db.accessTokens.save(
        token, expiration, authCode.userID, authCode.clientID, authCode.scope, (saveErr) => {
          if (saveErr) {
            return done(saveErr);
          }
          // I mimic openid connect's offline scope to determine if we send
          // a refresh token or not
          if (authCode.scope && authCode.scope.indexOf('offline_access') === 0) {
            const refreshToken = utils.uid(config.token.refreshTokenLength);
            return db.refreshTokens.save(
              refreshToken, authCode.userID, authCode.clientID, authCode.scope, (rSaveError) => {
                if (rSaveError) {
                  return done(rSaveError);
                }
                return done(null, token, refreshToken, { expires_in: config.token.expiresIn });
              });
          }
          return done(null, token, null, { expires_in: config.token.expiresIn });
        });
    });
  });
}));

/**
 * Exchange user id and password for access tokens.
 *
 * The callback accepts the `client`, which is exchanging the user's name and password
 * from the token request for verification. If these values are validated, the
 * application issues an access token on behalf of the user who authorized the code.
 */
server.exchange(oauth2orize.exchange.password((client, username, password, scope, done) => {
  // Validate the user
  db.users.findByUsername(username, (err, user) => {
    if (err) {
      return done(err);
    }
    if (!user) {
      return done(null, false);
    }
    if (password !== user.password) {
      return done(null, false);
    }
    const token      = utils.uid(config.token.accessTokenLength);
    const expiration = config.token.calculateExpirationDate();
    return db.accessTokens.save(token, expiration, user.id, client.id, scope, (saveErr) => {
      if (saveErr) {
        return done(saveErr);
      }
      // I mimic openid connect's offline scope to determine if we send
      // a refresh token or not
      if (scope && scope.indexOf('offline_access') === 0) {
        const refreshToken = utils.uid(config.token.refreshTokenLength);
        return db.refreshTokens.save(refreshToken, user.id, client.id, scope, (rSaveErr) => {
          if (rSaveErr) {
            return done(rSaveErr);
          }
          return done(null, token, refreshToken, { expires_in: config.token.expiresIn });
        });
      }
      return done(null, token, null, { expires_in: config.token.expiresIn });
    });
  });
}));

/**
 * Exchange the client id and password/secret for an access token.
 *
 * The callback accepts the `client`, which is exchanging the client's id and
 * password/secret from the token request for verification. If these values are validated, the
 * application issues an access token on behalf of the client who authorized the code.
 */
server.exchange(oauth2orize.exchange.clientCredentials((client, scope, done) => {
  const token      = utils.uid(config.token.accessTokenLength);
  const expiration = config.token.calculateExpirationDate();
  // Pass in a null for user id since there is no user when using this grant type
  db.accessTokens.save(token, expiration, null, client.id, scope, (err) => {
    if (err) {
      return done(err);
    }
    return done(null, token, null, { expires_in: config.token.expiresIn });
  });
}));

/**
 * Exchange the refresh token for an access token.
 *
 * The callback accepts the `client`, which is exchanging the client's id from the token
 * request for verification.  If this value is validated, the application issues an access
 * token on behalf of the client who authorized the code
 */
server.exchange(oauth2orize.exchange.refreshToken((client, refreshToken, scope, done) => {
  db.refreshTokens.find(refreshToken, (err, authCode) => {
    if (err) {
      return done(err);
    }
    if (!authCode) {
      return done(null, false);
    }
    if (client.id !== authCode.clientID) {
      return done(null, false);
    }
    const token      = utils.uid(config.token.accessTokenLength);
    const expiration = config.token.calculateExpirationDate();
    return db.accessTokens.save(
      token, expiration, authCode.userID, authCode.clientID, authCode.scope, (saveErr) => {
        if (saveErr) {
          return done(saveErr);
        }
        return done(null, token, null, { expires_in: config.token.expiresIn });
      });
  });
}));

/*
 * User authorization endpoint
 *
 * `authorization` middleware accepts a `validate` callback which is
 * responsible for validating the client making the authorization request.  In
 * doing so, is recommended that the `redirectURI` be checked against a
 * registered value, although security requirements may vary accross
 * implementations.  Once validated, the `done` callback must be invoked with
 * a `client` instance, as well as the `redirectURI` to which the user will be
 * redirected after an authorization decision is obtained.
 *
 * This middleware simply initializes a new authorization transaction.  It is
 * the application's responsibility to authenticate the user and render a dialog
 * to obtain their approval (displaying details about the client requesting
 * authorization).  We accomplish that here by routing through `ensureLoggedIn()`
 * first, and rendering the `dialog` view.
 */
exports.authorization = [
  login.ensureLoggedIn(),
  server.authorization((clientID, redirectURI, scope, done) => {
    db.clients.findByClientId(clientID, (err, client) => {
      if (err) {
        return done(err);
      }
      if (client) {
        client.scope = scope; // eslint-disable-line no-param-reassign
      }
      // WARNING: For security purposes, it is highly advisable to check that
      //          redirectURI provided by the client matches one registered with
      //          the server.  For simplicity, this example does not.  You have
      //          been warned.
      return done(null, client, redirectURI);
    });
  }), (req, res, next) => {
    // Render the decision dialog if the client isn't a trusted client
    // TODO:  Make a mechanism so that if this isn't a trusted client, the user can record that
    // they have consented but also make a mechanism so that if the user revokes access to any of
    // the clients then they will have to re-consent.
    db.clients.findByClientId(req.query.client_id, (err, client) => {
      if (!err && client && client.trustedClient && client.trustedClient === true) {
        // This is how we short call the decision like the dialog below does
        server.decision({ loadTransaction: false }, (serverReq, callback) => {
          callback(null, { allow: true });
        })(req, res, next);
      } else {
        res.render('dialog', { transactionID: req.oauth2.transactionID, user: req.user, client: req.oauth2.client });
      }
    });
  }];

/**
 * User decision endpoint
 *
 * `decision` middleware processes a user's decision to allow or deny access
 * requested by a client application.  Based on the grant type requested by the
 * client, the above grant middleware configured above will be invoked to send
 * a response.
 */
exports.decision = [
  login.ensureLoggedIn(),
  server.decision(),
];

/**
 * Token endpoint
 *
 * `token` middleware handles client requests to exchange authorization grants
 * for access tokens.  Based on the grant type being exchanged, the above
 * exchange middleware will be invoked to handle the request.  Clients must
 * authenticate when making requests to this endpoint.
 */
exports.token = [
  passport.authenticate(['basic', 'oauth2-client-password'], { session: false }),
  server.token(),
  server.errorHandler(),
];

// Register serialialization and deserialization functions.
//
// When a client redirects a user to user authorization endpoint, an
// authorization transaction is initiated.  To complete the transaction, the
// user must authenticate and approve the authorization request.  Because this
// may involve multiple HTTPS request/response exchanges, the transaction is
// stored in the session.
//
// An application must supply serialization functions, which determine how the
// client object is serialized into the session.  Typically this will be a
// simple matter of serializing the client's ID, and deserializing by finding
// the client by ID from the database.

server.serializeClient((client, done) => done(null, client.id));

server.deserializeClient((id, done) => {
  db.clients.find(id, (err, client) => {
    if (err) {
      return done(err);
    }
    return done(null, client);
  });
});

