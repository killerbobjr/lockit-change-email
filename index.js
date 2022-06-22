var	path = require('path'),
	fs = require('path'),
	events = require('events'),
	util = require('util'),
	express = require('express'),
	uuid = require('shortid'),
	pwd = require('couch-pwd'),
	ms = require('ms'),
	moment = require('moment'),
	Mail = require('lockit-sendmail'),
	debug = require('debug')('lockit');

/**
 * ChangeEmail constructor function.
 *
 * @param {Object} config
 * @param {Object} adapter
 */
var ChangeEmail = module.exports = function(cfg, adapter)
{
	if(!(this instanceof ChangeEmail))
	{
		return new ChangeEmail(cfg, adapter);
	}

	this.config = cfg;
	this.adapter = adapter;
	var	config = this.config;

	// call super constructor function
	events.EventEmitter.call(this);

	// set default route
	this.route = config.changeEmail.route || '/changeemail';

	this.changeemail = this.route.replace(/\W/g,'');
	this.title = this.changeemail && this.changeemail[0].toUpperCase() + this.changeemail.slice(1);

	// change URLs if REST is active
	if (config.rest)
	{
		this.route = config.rest.route + this.route;
	}

	uuid.characters();

	var router = express.Router();
	router.get(this.route, this.getChange.bind(this));
	router.post(this.route, this.postChange.bind(this));
	router.get(this.route + '/:token', this.getToken.bind(this));
	this.router = router;
};

util.inherits(ChangeEmail, events.EventEmitter);



/**
 * Response handler
 *
 * @param {Object} err
 * @param {String} view
 * @param {Object} user
 * @param {Object} redirect
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
ChangeEmail.prototype.sendResponse = function(err, view, user, json, redirect, req, res, next)
{
	var	config = this.config;

	this.emit((config.changeEmail.eventMessage || 'ChangeEmail'), err, view, user, res);
	
	if(config.changeEmail.handleResponse)
	{
		// do not handle the route when REST is active
		if(config.rest || req.query.rest)
		{
			if(err)
			{
				// Duplicate to make it easy for REST
				// response handlers to detect
				if(!err.error)
				{
					err.error = err.message;
				}
				res.json(err);
			}
			else
			{
				if(redirect)
				{
					json.redirect = redirect;
				}
				res.json(json);
			}
		}
		else
		{
			// custom or built-in view
			var	resp = {
					title: config.changeEmail.title || this.title,
					basedir: req.app.get('views')
				};
				
			if(err)
			{
				resp.error = err.message;
			}
			else if(req.query && req.query.error)
			{
				resp.error = decodeURIComponent(req.query.error);
			}
			
			if(view)
			{
				var	file = path.resolve(path.normalize(resp.basedir + '/' + view));
				res.render(view, Object.assign(resp, json));
			}
			else if(redirect)
			{
				res.redirect(redirect);
			}
			else
			{
				res.status(404).send('<p>No file has been set in the configuration for this view path.</p><p>Please make sure you set a valid file for the "changeEmail.views" configuration.</p>');
			}
		}
	}
	else
	{
		next(err);
	}
};



/**
 * GET /change-email
 *
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
ChangeEmail.prototype.getChange = function(req, res, next)
{
	var	config = this.config,
		// save redirect url
		suffix = req.query.redirect ? '?redirect=' + encodeURIComponent(req.query.redirect) : '';

	this.sendResponse(undefined, config.changeEmail.views.changeEmail, undefined, {action:this.route + suffix, view:this.changeemail}, undefined, req, res, next);
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
	var	config = this.config,
		adapter = this.adapter,
		that = this,
		name = req.body.name,
		newemail = req.body.email,
		password = req.body.password,
		error,
		checkEmail = function(e)
		{
			var emailRegex = /^(([^<>()[\]\.,;:\s@\"]+(\.[^<>()[\]\.,;:\s@\"]+)*)|(\".+\"))@(([^<>()[\]\.,;:\s@\"]+\.)+[^<>()[\]\.,;:\s@\"]{2,})$/i;
			if(emailRegex.exec(e) && emailRegex.exec(e)[0] === e)
			{
				return true;
			}
			return false;
		};

	// check for valid input
	if(!newemail || !checkEmail(newemail))
	{
		this.sendResponse({message:'That email is invalid'}, config.changeEmail.views.changeEmail, undefined, {view:this.changeemail}, undefined, req, res, next);
	}
	else if(!password)
	{
		this.sendResponse({message:'Please enter your password'}, config.changeEmail.views.changeEmail, undefined, {view:this.changeemail}, undefined, req, res, next);
	}
	else
	{
		// Looks like the email address has the correct format
		// and a password has been provided.

		// Custom for our app
		var	basequery = {};
		if(res.locals && res.locals.basequery)
		{
			basequery = res.locals.basequery;
		}

		// Get the user record
		adapter.find('name', name, basequery, function(err, user)
			{
				if(err)
				{
					next(err);
				}
				else if(user)
				{
					debug('found current user');
					
					if(user.accountInvalid)
					{
						that.sendResponse({message:'Your current account is invalid'}, config.changeEmail.views.changeEmail, user, {view:that.changeemail}, undefined, req, res, next);
					}
					else if(!user.emailVerified)
					{
						// Signup email has not been verified. Load the signup verification route.
						that.sendResponse(undefined, undefined, user, {view:'resend'}, config.signup.resendRoute, req, res, next);
					}
					else
					{
						var timespan;
						
						// if user comes from couchdb it has an 'iterations' key
						if(user.iterations)
						{
							pwd.iterations(user.iterations);
						}

						debug('compare credentials with data in db');

						// compare credentials with data in db
						pwd.hash(password, user.salt, function(err, hash)
							{
								if(err)
								{
									next(err);
								}
								else if(hash !== user.derived_key)
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
										timespan = ms(config.accountLockedTime);
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
											{
												next(err);
											}
											else
											{
												that.sendResponse({message:errorMessage}, config.changeEmail.views.changeEmail, user, {view:that.changeemail}, undefined, req, res, next);
											}
										});
								}
								else
								{
									// looks like password is correct
									debug('looks like password is correct');
									
									// user found in db
									user.newEmail = newemail;
									
									// do not change email until verified
									// send link for verifying new email
									var token = uuid.generate();
									user.emlChangeToken = token;

									// set expiration date for email reset token
									timespan = ms(config.changeEmail.tokenExpiration);
									user.emlChangeTokenExpires = moment().add(timespan, 'ms').toDate();

									// update user in db
									adapter.update(user, function(err, user)
										{
											if(err)
											{
												next(err);
											}
											else
											{
												// send email with change email link
												var	mail = new Mail(config),
													emailto;

												if(user.email.length)
												{
													// Validate previous email
													emailto = user.email;
												}
												else
												{
													// Validate new email
													emailto = newemail;
												}
												
												mail.change(user.name, emailto, token, function(err, response)
													{
														if(err)
														{
															that.sendResponse(err, config.changeEmail.views.changeEmail, user, {view:that.changeemail}, undefined, req, res, next);
														}
														else
														{
															that.sendResponse(undefined, config.changeEmail.views.sentChangeEmail, user, {view:'sentChangeEmail'}, undefined, req, res, next);
														}
													});
											}
										});
								}
							});
					}
				}
				else
				{
					that.sendResponse({message:'User name not found'}, config.changeEmail.views.changeEmail, user, {view:that.changeemail}, undefined, req, res, next);
				}
			});
	}
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
	var	config = this.config,
		adapter = this.adapter,
		that = this,
		token = req.params.token;	// get token from url

	// if format is wrong no need to query the database
	if(!uuid.isValid(token))
	{
		next({message:'Invalid token'});
	}
	else
	{
		// Custom for our app
		var	basequery = {};
		if(res.locals && res.locals.basequery)
		{
			basequery = res.locals.basequery;
		}

		// check if we have a user with that token
		adapter.find('emlChangeToken', token, basequery, function(err, user)
			{
				if(err)
				{
					next(err);
				}
				// if no user is found, check for reset
				else if(!user)
				{
					delete basequery.emlChangeToken;

					// check if the token is for resetting back to the old email
					adapter.find('emlResetToken', token, basequery, function(err, user)
						{
							if(err)
							{
								next(err);
							}
							// if no user is found forward to error handling middleware
							else if(!user)
							{
								that.sendResponse({message:'That code is invalid'}, config.changeEmail.views.resetExpired, user, {view:'resetExpired'}, undefined, req, res, next);
							}
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
										{
											next(err);
										}
										else
										{
											that.sendResponse({message:'That code has expired'}, config.changeEmail.views.resetExpired, user, {view:'resetExpired'}, undefined, req, res, next);
										}
									});
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
										{
											next(err);
										}
										else
										{
											// Success!
											that.sendResponse(undefined, config.changeEmail.views.resetEmail, user, {view:'resetEmail'}, undefined, req, res, next);
										}
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
							{
								next(err);
							}
							else
							{
								that.sendResponse({message:'That reset has expired'}, config.changeEmail.views.resetExpired, user, {view:'resetExpired'}, undefined, req, res, next);
							}
						});
				}
				else
				{
					// remove helper properties
					delete user.emlChangeToken;
					delete user.emlChangeTokenExpires;
					
					// save new email
					if(user.email.length)
					{
						user.oldEmail = user.email;
					}
					else
					{
						delete user.oldEmail;
					}
					user.email = user.newEmail;
					delete user.newEmail;
					user.emailVerified = false;
					
					// update user in db
					adapter.update(user, function(err, user)
						{
							if(err)
							{
								next(err);
							}
							else if(user.oldEmail && user.oldEmail.length)
							{
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
										{
											next(err);
										}
										else
										{
											// send email with change email link
											var mail = new Mail(config);
											
											mail.reset(user.name, user.oldEmail, token, function(err, response)
												{
													if(err)
													{
														that.sendResponse(err, config.changeEmail.views.changeEmail, user, {view:that.changeemail}, undefined, req, res, next);
													}
													else
													{
														// Success!
														that.sendResponse(undefined, config.changeEmail.views.changedEmail, user, {view:'changedEmail'}, undefined, req, res, next);
													}
												});
										}
									});
							}
							else
							{
								// Success!
								that.sendResponse(undefined, config.changeEmail.views.changedEmail, user, {view:'changedEmail'}, undefined, req, res, next);
							}
						});
				}
			});
	}
};
