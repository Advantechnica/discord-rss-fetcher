//external library imports
var Dns = require("dns"); //for connectivity checking
var Url = require("url"); //for url parsing
var Uri = require("urijs"); //for finding urls within message strings
var Discord = require("discord.io"); //for obvious reasons
var FeedRead = require("feed-read"); //for rss feed reading

//my imports
var Log = require("./log.js"); //some very simple logging functions I made
var BotConfig = require("./bot-config.json"); //bot config file containing bot token
var Config = require("./config.json"); //config file containing other settings

var DiscordClient = {
	bot: null,
	feedTimer: null,
	reconnectTimer: null,
	startup: function () {
		//check if we can connect to discordapp.com to authenticate the bot
		Dns.resolve("discordapp.com", function (err) {
			if (err) Log.error("CONNECTION ERROR: Unable to locate discordapp.com to authenticate the bot", err);
			else {
				//if there was no error, go ahead and create and authenticate the bot
				DiscordClient.bot = new Discord.Client({
					token: BotConfig.token,
					autorun: true
				});

				//set up the bot's event handlers
				DiscordClient.bot.on("ready", DiscordClient.onReady);
				DiscordClient.bot.on("disconnect", DiscordClient.onDisconnect);
				DiscordClient.bot.on("message", DiscordClient.onMessage);
			}
		});
	},
	onReady: function () {
		Log.info("Registered/connected bot " + DiscordClient.bot.username + " - (" + DiscordClient.bot.id + ")");

		Log.info("Setting up timer to check feed every " + Config.pollingInterval + " milliseconds");
		DiscordClient.feedTimer = setInterval(Feed.checkAndPost, Config.pollingInterval); //set up the timer to check the feed

		//we need to check past messages for links on startup, but also on reconnect because we don't know what has happened during the downtime
		DiscordClient.checkPastMessagesForLinks();
	},
	onDisconnect: function (err, code) {
		Log.event("Bot was disconnected! " + err ? err : "" + code ? code : "No disconnect code provided.\nClearing the feed timer and starting reconnect timer", "Discord.io");

		clearInterval(DiscordClient.feedTimer); //stop the feed timer

		//set up a timer to try reconnect every 5sec
		DiscordClient.reconnectTimer = setInterval(function () {
			try {
				DiscordClient.bot.connect();
			}
			catch (ex) {
				Log.error("Exception thrown trying to reconnect bot." + ex.message);
			}
		});
	},
	onMessage: function (user, userID, channelID, message) {
		//check if the message is in the right channel, contains a link, and is not the latest link from the rss feed
		if (channelID === Config.channelID && Links.messageContainsLink(message) && (message !== Links.latestFromFeed)) {
			Log.event("Detected posted link in this message: " + message, "Discord.io");

			//extract the url from the string, and cache it
			Uri.withinString(message, function (url) {
				Links.cache(Links.standardise(url));
				return url;
			});
		}
	},
	//gets last 100 messages and extracts any links found (for use on startup)
	checkPastMessagesForLinks: function () {
		var limit = 100;
		Log.info("Attempting to check past " + limit + " messages for links");

		//get the last however many messsages from our discord channel
		DiscordClient.bot.getMessages({
			channelID: Config.channelID,
			limit: limit
		}, function (err, messages) {
			if (err) Log.error("Error fetching discord messages.", err);
			else {
				Log.info("Pulled last " + messages.length + " messages, scanning for links");

				//extract an array of strings from the array of message objects
				var messageContents = messages.map((x) => { return x.content; }).reverse();

				for (var messageIdx in messageContents) {
					var message = messageContents[messageIdx];

					//test if the message contains a url
					if (Links.messageContainsLink(message))
						//detect the url inside the string, and cache it
						Uri.withinString(message, function (url) {
							Links.cache(url);
							return url;
						});
				}
			}
		});
	}
};

var YouTube = {
	url: {
		share: "http://youtu.be/",
		full: "http://www.youtube.com/watch?v=",
		convertShareToFull: function (shareUrl) {
			return shareUrl.replace(YouTube.url.share, YouTube.url.full);
		},
		convertFullToShare: function (fullUrl) {
			var shareUrl = fullUrl.replace(YouTube.url.full, YouTube.url.share);

			if (shareUrl.includes("&"))
				shareUrl = shareUrl.slice(0, fullUrl.indexOf("&"));

			return shareUrl;
		}
	},
};

var Links = {
	standardise: function (link) {
		//cheaty way to get around http and https not matching
		return link.replace("https://", "http://");
	},
	messageContainsLink: function (message) {
		var messageLower = message.toLowerCase();
		return messageLower.includes("http://") || messageLower.includes("https://") || messageLower.includes("www.");
	},
	cached: [],
	latestFromFeed: "",
	cache: function (link) {
		link = Links.standardise(link);

		if (Config.youtubeMode && link.includes(YouTube.url.full)) {
			link = YouTube.url.convertFullToShare(link);
		}

		//store the new link if not stored already
		if (!Links.cached.includes(link)) {
			Links.cached.push(link);
			Log.info("Cached URL: " + link);
		}
		//get rid of the first array element if we have reached our cache limit
		if (Links.cached.length > (Config.numLinksToCache || 10))
			Links.cached.shift();
	},
	checkCache: function (link) {
		link = Links.standardise(link);

		if (Config.youtubeMode && link.includes(YouTube.url.full)) {
			return Links.cached.includes(YouTube.url.convertFullToShare(link));
		}
		return Links.cached.includes(link);
	},
	validateAndPost: function (err, articles) {
		if (err) Log.error("FEED ERROR: Error reading RSS feed.", err);
		else {
			//get the latest link and check if it has already been posted and cached
			var latestLink = Links.standardise(articles[0].link);

			//check whether the latest link out the feed exists in our cache
			if (!Links.checkCache(latestLink)) {
				if (Config.youtubeMode && latestLink.includes(YouTube.url.full))
					latestLink = YouTube.url.convertFullToShare(latestLink);
				Log.info("Attempting to post new link: " + latestLink);

				//send a messsage containing the new feed link to our discord channel
				DiscordClient.bot.sendMessage({
					to: Config.channelID,
					message: latestLink
				}, function (err, message) {
					if (err) {
						Log.error("ERROR: Failed to send message: " + message.substring(0, 15) + "...", err);
						//if there is an error posting the message, check if it is because the bot isn't connected
						if (DiscordClient.bot.connected)
							Log.info("Connectivity seems fine - I have no idea why the message didn't post");
						else {
							Log.error("DiscordClient appears to be disconnected! Attempting to reconnect...", err);

							//attempt to reconnect
							DiscordClient.bot.connect();
						}
					}
				});

				//finally make sure the link is cached, so it doesn't get posted again
				Links.cache(latestLink);
			}
			else if (Links.latestFromFeed != latestLink)
				//alternatively, if we have a new link from the feed, but its been posted already, just alert the console
				Log.info("Didn't post new feed link because already detected as posted " + latestLink);

			//ensure our latest feed link variable is up to date, so we can track when the feed updates
			Links.latestFromFeed = latestLink;
		}
	}
};

var Feed = {
	urlObj: Url.parse(Config.feedUrl),
	checkAndPost: function () {
		//check that we have an internet connection (well not exactly - check that we have a connection to the host of the feedUrl)
		Dns.resolve(Feed.urlObj.host, function (err) {
			if (err) Log.error("CONNECTION ERROR: Cannot resolve host.", err);
			else FeedRead(Config.feedUrl, Links.validateAndPost);
		});
	}
};

//IIFE to kickstart the bot when the app loads
(function () {
	DiscordClient.startup();
})();