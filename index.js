var path = require('path');
var events = require('events');
var util = require('util');
var express = require('express');
var uuid = require('shortid');
var pwd = require('couch-pwd');
var ms = require('ms');
var moment = require('moment');
var Mail = require('lockit-sendmail');
var debug = require('debug')('lockit');

/**
 * Internal helper functions
 */
function join(view)
{
	return path.join(__dirname, 'views', view);
}

/**
 * ChangeEmail constructor function.
 *
 * @param {Object} config
 * @param {Object} adapter
 */
var ChangeEmail = module.exports = function(config, adapter)
{

	if(!(this instanceof ChangeEmail))
		return new ChangeEmail(config, adapter);

	// call super constructor function
	events.EventEmitter.call(this);

	this.config = config;
	this.adapter = adapter;

	// set default route
	var route = config.changeEmail.route || '/change-email';

	// add prefix when rest is active
	if(config.rest) 
		route = '/rest' + route;

	/**
	 * Routes
	 */

	var router = express.Router();
	router.get(route, this.getChange.bind(this));
	router.post(route, this.postChange.bind(this));
	router.get(route + '/:token', this.getToken.bind(this));
	this.router = router;

};

util.inherits(ChangeEmail, events.EventEmitter);



/**
 * GET /change-email
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
ChangeEmail.prototype.getChange = function(req, res, next)
{
	var config = this.config;

	// do not handle the route when REST is active
	if(config.rest)
		return next();

	// custom or built-in view
	var view = config.changeEmail.views.changeEmail || join('get-change-email');

	res.render(view,
		{
			title: 'Change email',
			basedir: req.app.get('views')
		});
};



/**
 * POST /change-email
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
ChangeEmail.prototype.postChange = function(req, res, next)
{
	var config = this.config;
	var adapter = this.adapter;
	var that = this;
	var email = req.user?req.user.email || '':'';
	var newemail = req.body.email;
	var password = req.body.password;

	var error = null;
	// regexp from https://github.com/angular/angular.js/blob/master/src/ng/directive/input.js#L4
	var EMAIL_REGEXP = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}$/;

	// check for valid input
	if(!newemail || !newemail.match(EMAIL_REGEXP))
	{
		error = 'Email is invalid';

		// send only JSON when REST is active
		if(config.rest) 
			return res.json(403,
				{
					error: error
				});

		// custom or built-in view
		var errorView = config.changeEmail.views.changeEmail || join('get-change-email');

		res.status(403);
		res.render(errorView,
			{
				title: 'Change email',
				error: error,
				basedir: req.app.get('views'),
				email: newemail
			});
		return;
	}
	
	if(!password)
	{
		error = 'Please enter your password';

		// send only JSON when REST is active
		if(config.rest)
			return res.json(403,
				{
					error: error
				});

		// custom or built-in view
		var errorView = config.changeEmail.views.changeEmail || join('get-change-email');

		// render view
		res.status(403);
		res.render(errorView,
			{
				title: 'Change email',
				error: error,
				basedir: req.app.get('views'),
				email: newemail
			});
		return;
	}

	// looks like given email address has the correct format

	// look for any account using new email
	adapter.find('email', newemail, function(err, user)
		{
			if(err)
				return next(err);
			else if(user)
			{
				error = 'That email is already used by another account';
				// send only JSON when REST is active
				if(config.rest)
					return res.json(403,
						{
							error: error
						});

				var errorView = config.changeEmail.views.changeEmail || join('get-change-email');

				// render template with error message
				res.status(403);
				res.render(errorView,
					{
						title: 'Change email',
						error: error,
						basedir: req.app.get('views'),
						email: newemail
					});
				return;
			}
			else
			{
				debug('get current user');
				// get current user
				adapter.find('email', email, function(err, user)
					{
						if(err)
							return next(err);
						else if(user)
						{
							debug('found current user');
							
							if(user.accountInvalid)
							{
								error = 'Your current account is invalid';
								// send only JSON when REST is active
								if(config.rest)
									return res.json(403,
										{
											error: error
										});

								var errorView = config.changeEmail.views.changeEmail || join('get-change-email');

								// render template with error message
								res.status(403);
								res.render(errorView,
									{
										title: 'Change email',
										error: error,
										basedir: req.app.get('views'),
										email: newemail
									});
								return;
							}
							else if(!user.emailVerified)
							{
								error = 'Your current email has not been verified';
								// send only JSON when REST is active
								if(config.rest)
									return res.json(403,
										{
											error: error
										});

								var errorView = config.changeEmail.views.changeEmail || join('get-change-email');

								// render template with error message
								res.status(403);
								res.render(errorView,
									{
										title: 'Resend verification email',
										error: error,
										basedir: req.app.get('views'),
										email: email
									});
								return;
							}

							// if user comes from couchdb it has an 'iterations' key
							if(user.iterations)
								pwd.iterations(user.iterations);

							debug('compare credentials with data in db');

							// compare credentials with data in db
							pwd.hash(password, user.salt, function(err, hash)
								{
									if(err)
										return next(err);

									if(hash !== user.derived_key)
									{
										// set the default error message
										var errorMessage = 'Invalid password';

										// increase failed login attempts
										user.failedLoginAttempts += 1;

										// lock account on too many login attempts (defaults to 5)
										if(user.failedLoginAttempts >= config.failedLoginAttempts)
										{
											user.accountLocked = true;

											// set locked time to 20 minutes (default value)
											var timespan = ms(config.accountLockedTime);
											user.accountLockedUntil = moment().add(timespan, 'ms').toDate();

											errorMessage = 'Invalid password. Your account is now locked for ' + config.accountLockedTime;
										}
										else if(user.failedLoginAttempts >= config.failedLoginsWarning)
										{
											// show a warning after 3 (default setting) failed login attempts
											errorMessage = 'Invalid password. Your account will be locked soon.';
										}

										// save user to db
										adapter.update(user, function(err, user)
											{
												if(err)
													return next(err);

												// send only JSON when REST is active
												if(config.rest)
													return res.json(403,
														{
															error: errorMessage
														});
														
												var errorView = config.changeEmail.views.changeEmail || join('get-change-email');

												// send error message
												res.status(403);
												res.render(errorView,
												{
													title: 'Change email',
													error: errorMessage,
													basedir: req.app.get('views'),
													email: newemail
												});
											});
										return;
									}

									// looks like password is correct
									debug('looks like password is correct');
									
									// user found in db
									user.newEmail = newemail;
									
									// do not change email until verified
									// send link for verifying new email
									var token = uuid.generate();
									user.emlChangeToken = token;

									// set expiration date for email reset token
									var timespan = ms(config.changeEmail.tokenExpiration);
									user.emlChangeTokenExpires = moment().add(timespan, 'ms').toDate();

									// update user in db
									adapter.update(user, function(err, user)
										{
											if(err)
												return next(err);

											// send email with change email link
											var mail = new Mail(config);
											
											mail.change(user.name, user.email, token, function(err, response)
												{
													if(err)
														return next(err);

													// emit event
													that.emit('change::sent', user, res);

													// send only JSON when REST is active
													if(config.rest)
														return res.send(204);
													
													var view = config.changeEmail.views.sentEmail || join('get-sent-email');

													res.render(view,
														{
															title: 'Change email',
															basedir: req.app.get('views')
														});
												});
										});
								});
						}
					});
			}
		});
};



/**
 * GET /change-email/:token
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
ChangeEmail.prototype.getToken = function(req, res, next)
{
	var config = this.config;
	var adapter = this.adapter;
	var that = this;

	// get token from url
	var token = req.params.token;

	// if format is wrong no need to query the database
	if(!uuid.isValid(token))
	{
		return next({message:'Invalid token'});
	}

	// check if we have a user with that token
	adapter.find('emlChangeToken', token, function(err, user)
		{
			if(err)
				return next(err);

			// if no user is found, check for reset
			else if(!user)
			{
				// check if the token is for resetting back to the old email
				adapter.find('emlResetToken', token, function(err, user)
					{
						if(err)
							return next(err);

						// if no user is found forward to error handling middleware
						else if(!user)
							return next();

						// check if token has expired
						else if(new Date(user.emlResetTokenExpires) < new Date())
						{
							// make old token invalid
							delete user.emlResetToken;
							delete user.emlResetTokenExpires;
							// resetting to the old email is no longer valid
							delete user.oldEmail;

							// update user in db
							adapter.update(user, function(err, user)
								{
									if(err)
										return next(err);

									// send only JSON when REST is active
									if(config.rest)
										return res.json(403,
											{
												error: 'link expired'
											});

									// custom or built-in view
									var view = config.changeEmail.views.linkExpired || join('link-expired');

									// tell user that link has expired
									res.render(view,
										{
											title: 'Change email - Link expired',
											basedir: req.app.get('views')
										});
								});

							return;
						}
						else
						{
							// remove helper properties
							delete user.emlResetToken;
							delete user.emlResetTokenExpires;
							
							// save old email
							user.email = user.oldEmail;
							delete user.oldEmail;
							
							// update user in db
							adapter.update(user, function(err, user)
								{
									if(err)
										return next(err);

									// emit event
									that.emit('change::success', user, res);

									// send only JSON when REST is active
									if(config.rest)
										return res.send(204);

									// custom or built-in view
									var view = config.changeEmail.views.resetEmail || join('change-email-success');

									// render success message
									res.render(view,
										{
											title: 'Email changed',
											basedir: req.app.get('views')
										});
								});
						}
					});
			}
			// check if token has expired
			else if(new Date(user.emlChangeTokenExpires) < new Date())
			{
				// make old token invalid
				delete user.emlChangeToken;
				delete user.emlChangeTokenExpires;
				// requested email is no longer valid
				delete user.newEmail;

				// update user in db
				adapter.update(user, function(err, user)
					{
						if(err)
							return next(err);

						// send only JSON when REST is active
						if(config.rest)
							return res.json(403,
								{
									error: 'link expired'
								});

						// custom or built-in view
						var view = config.changeEmail.views.linkExpired || join('link-expired');

						// tell user that link has expired
						res.render(view,
							{
								title: 'Change email - Link expired',
								basedir: req.app.get('views')
							});
					});
			}
			else
			{
				// remove helper properties
				delete user.emlChangeToken;
				delete user.emlChangeTokenExpires;
				
				// save new email
				user.oldEmail = user.email;
				user.email = user.newEmail;
				delete user.newEmail;
				
				// update user in db
				adapter.update(user, function(err, user)
					{
						if(err)
							return next(err);

						// send link for resetting back to old email
						var token = uuid.generate();
						user.emlResetToken = token;

						// set expiration date for email reset token
						var timespan = ms(config.changeEmail.tokenExpirationOfReset);
						user.emlResetTokenExpires = moment().add(timespan, 'ms').toDate();

						// update user in db
						adapter.update(user, function(err, user)
							{
								if(err)
									return next(err);

								// send email with change email link
								var mail = new Mail(config);
								
								mail.reset(user.name, user.oldEmail, token, function(err, response)
									{
										if(err)
											return next(err);

										// emit event
										that.emit('change::success', user, res);

										// send only JSON when REST is active
										if(config.rest)
											return res.send(204);

										// custom or built-in view
										var view = config.changeEmail.views.changedEmail || join('change-email-success');

										// render success message
										res.render(view,
											{
												title: 'Email changed',
												basedir: req.app.get('views')
											});
									});
							});
					});
			}
		});
};
