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

	this.config = cfg.changeEmail;
	this.config.failedLoginAttempts = cfg.failedLoginAttempts;
	this.config.accountLockedTime = cfg.accountLockedTime;
	this.config.failedLoginsWarning = cfg.failedLoginsWarning;
	this.config.mail = cfg;
	this.adapter = adapter;

	var	config = this.config;

	// call super constructor function
	events.EventEmitter.call(this);

	// set default route
	var route = config.route || '/changeemail';

	// add prefix when rest is active
	if(config.rest) 
	{
		route = '/' + config.rest + route;
	}

	uuid.characters();

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
 * Response handler
 *
 * @param {Object} err
 * @param {String} view
 * @param {Object} user
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
ChangeEmail.prototype.sendResponse = function(err, view, user, json, req, res, next)
{
	var	config = this.config;

	this.emit((config.eventmsg || config.route), err, view, user, res);
	
	if(config.handleResponse)
	{
		// do not handle the route when REST is active
		if(config.rest)
		{
			if(err)
			{
				res.status(403).json(err);
			}
			else
			{
				res.json(json);
			}
		}
		else
		{
			// custom or built-in view
			var	resp = {
					title: config.title || 'Change email',
					basedir: req.app.get('views')
				};
				
			if(err)
			{
				resp.error = err.message;
			}
			
			if(view)
			{
				var	file = path.resolve(path.normalize(resp.basedir + '/' + view));
				res.render(view, Object.assign(resp, json));
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
	var	config = this.config;
	this.sendResponse(undefined, config.views.changeEmail, undefined, {result:true}, req, res, next);
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
		email = req.user?req.user.email || '':'',
		name = req.user?req.user.name || '':'',
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
		this.sendResponse({message:'The email is invalid'}, config.views.changeEmail, undefined, {result:true}, req, res, next);
	}
	else if(!password)
	{
		this.sendResponse({message:'Please enter your password'}, config.views.changeEmail, undefined, {result:true}, req, res, next);
	}
	else
	{
		// looks like given email address has the correct format

		// Custom for our app
		var	basequery = {};
		if(res.locals && res.locals.basequery)
		{
			basequery = res.locals.basequery;
		}

		// look for any account using new email
		adapter.find('email', newemail, function(err, user)
			{
				if(err)
				{
					next(err);
				}
				else if(user)
				{
					that.sendResponse({message:'That email is already in use'}, config.views.changeEmail, user, {result:true}, req, res, next);
				}
				else
				{
					debug('get current user');
					// get current user
					var	field,
						value;
					if(email.length > 0)
					{
						field = 'email';
						value = email;
						delete basequery.name;
					}
					else
					{
						field = 'name';
						value = name;
						delete basequery.email;
					}
					adapter.find(field, value, function(err, user)
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
									that.sendResponse({message:'Your current account is invalid'}, config.views.changeEmail, user, {result:true}, req, res, next);
								}
								else if(user.email.length && !user.emailVerified)
								{
									that.sendResponse({message:'Your current email has not been verified'}, config.views.changeEmail, user, {result:true}, req, res, next);
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
															that.sendResponse({message:errorMessage}, config.views.changeEmail, user, {result:true}, req, res, next);
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
												timespan = ms(config.tokenExpiration);
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
															var	mail = new Mail(config.mail),
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
																		next(err);
																	}
																	else
																	{
																		that.sendResponse(undefined, config.views.sentEmail, user, {result:true}, req, res, next);
																	}
																});
														}
													});
											}
										});
								}
							}
						}, basequery);
				}
			}, basequery);
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
		adapter.find('emlChangeToken', token, function(err, user)
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
					adapter.find('emlResetToken', token, function(err, user)
						{
							if(err)
							{
								next(err);
							}
							// if no user is found forward to error handling middleware
							else if(!user)
							{
								that.sendResponse({message:'That link is invalid'}, config.views.resetExpired, user, {result:true}, req, res, next);
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
											that.sendResponse({message:'The link has expired'}, config.views.linkExpired, user, {result:true}, req, res, next);
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
											that.sendResponse(undefined, config.views.changedEmail, user, {result:true}, req, res, next);
										}
									});
							}
						}, basequery);
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
								that.sendResponse({message:'The link has expired'}, config.views.linkExpired, user, {result:true}, req, res, next);
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
								var timespan = ms(config.tokenExpirationOfReset);
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
											var mail = new Mail(config.mail);
											
											mail.reset(user.name, user.oldEmail, token, function(err, response)
												{
													if(err)
													{
														next(err);
													}
													else
													{
														// Success!
														that.sendResponse(undefined, config.views.changedEmail, user, {result:true}, req, res, next);
													}
												});
										}
									});
							}
							else
							{
								// Success!
								that.sendResponse(undefined, config.views.changedEmail, user, {result:true}, req, res, next);
							}
						});
				}
			}, basequery);
	}
};
