# Lockit change email

[![Build Status](https://travis-ci.org/killerbobjr/lockit-change-email.svg?branch=master)](https://travis-ci.org/killerbobjr/lockit-change-email)
[![NPM version](https://badge.fury.io/js/lockit-change-email.svg)](http://badge.fury.io/js/lockit-change-email)
[![Dependency Status](https://david-dm.org/killerbobjr/lockit-change-email.svg)](https://david-dm.org/killerbobjr/lockit-change-email)

Supplies validation for changing email addresses for your Express app. The module is part of [Lockit](https://github.com/killerbobjr/lockit).

## Installation

`npm install lockit-change-email`

```js
var ChangeEmail = require('lockit-change-email');
var utils = require('lockit-utils');
var config = require('./config.js');

var db = utils.getDatabase(config);
var adapter = require(db.adapter)(config);

var app = express();

// express settings
// ...
// sessions are required - either cookie or some sort of db
app.use(cookieParser());
app.use(cookieSession({
  secret: 'this is my super secret string'
}));

// create new ChangeEmail instance
var changeEmail = new ChangeEmail(config, adapter);

// use changeEmail.router with your app
app.use(changeEmail.router);
```

## Configuration

More about configuration at [Lockit](https://github.com/killerbobjr/lockit).

## Features

 - allow changing of email address with verification sent to new address and a reset link sent to old address
 - input validation
 - link expiration times
 - user email verification via unique token
 - hash password using [pbkdf2](http://nodejs.org/api/crypto.html#crypto_crypto_pbkdf2_password_salt_iterations_keylen_callback)
 - token format verification before database querying

## Routes included

 - GET /change-email
 - POST /change-email
 - GET /change-email/:token

## REST API

If you've set `exports.rest` in your `config.js` the module behaves as follows.

 - all routes have `/rest` prepended
 - `GET /rest/change-email` is `next()`ed and you can catch `/change-email` on the client
 - `POST /rest/change-email` stays the same but sends JSON
 - `GET /rest/change-email/:token` sends JSON and you can catch `/change-email/:token` on the client

## Test

none

## License

MIT
