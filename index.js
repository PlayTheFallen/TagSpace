const Eris = require('eris');
const _ = require('lodash');
const assert = require('assert');
const fs = require('fs');
const fuzzy = require('fuzzy');
const childProcess = require('child_process');
const path = require('path');
const mimimist = require('minimist')
const util = require('util');
const vm = require('vm2');
const _config = require('./_config.json');

const _util = {

	truthy: new Set(['true', 't', 'yes', 'y', 'on', 'enable', 'enabled', '1', '+']),
	// null: ['null', 'nil', 'wat', '-1'],
	falsy: new Set(['false', 'f', 'no', 'n', 'off', 'disable', 'disabled', '0', '-']),

	200: ":heavy_check_mark: **[`200`] OK**",
	401: ":x: **[`401`] Unauthorized**",
	403: ":x: **[`403`] Forbidden**",
	404: ":x: **[`404`] Not found**",
	501: ":x: **[`501`] Not implemented.**",
	stringify(data) {
		return JSON.stringify(data, null, 2);
	},
	random(arr) {
		return arr[Math.floor(Math.random() * arr.length)];
	},
	saveUser(id, data) {
		userData.set(id, data);
		fs.writeFileSync(`./userData/${id}.json`, this.stringify(data));
	},
	getUser(id) {
		return userData.get(id) || {
			isAdmin: false,
			isBanned: false,
			favorites: [],
			spaces: []
		}
	},
	resolveBoolean(val) {
		val = val.toLowerCase();
		if (this.truthy.has(val)) return true;
		else if (this.falsy.has(val)) return false;
		else return null;
	},
	isAdmin(id) {
		let uData = this.getUser(id);
		return uData.isAdmin;
	},
	isBanned(id) {
		let uData = this.getUser(id);
		return uData.isBanned;
	},
	forbiddenNames: ['_meta', 'random'],
	forbiddenChars: ['/', '@', '\\', '[', ']', '\n', '\t'],
	tagRegex: /\[>[^\s]*\/[^\s]*\]/g,
	SYSTEM: {
		username: "SYSTEM",
		discriminator: "0000",
		id: "-1"
	},
	tagsPerPage: 50
}

const _code = `\`\`\``; //`

class Space {
	/**
	 * 
	 * @param {String} name 
	 */
	constructor(name) {
		/**
		 * @type {String}
		 */
		this.name = name;
		/**
		 * @type {Map<String, Tag>}
		 */
		this.tags = new Map();
		/**
		 * @type {String[]}
		 */
		this.rawTags = [];
		this.load();
	}

	/**
	 * 
	 * @param {String} name 
	 * @param {external:Eris.User|_util.SYSTEM} author 
	 * @param {Object} [options={}]
	 * @param {Boolean} [options.private=false]
	 * @param {String[]} [options.contributors=[]]
	 * @param {Boolean} [options.limited=false]
	 */
	static create(name, author, options = {}) {
		options = _.merge({
			private: false,
			limited: false,
			contributors: []
		}, options);
		if (spaces.has(name)) return this;
		let data = {
			author: author.id,
			contributors: [author.id, ...(options.contributors || [])],
			tags: [],
			lastModified: new Date().toISOString(),
			private: options.private,
			limited: options.limited
		};
		fs.mkdirSync(`./_/${name}`);
		fs.writeFileSync(`./_/${name}/_meta.json`, _util.stringify(data));
		let uData = _util.getUser(author.id);
		uData.spaces.push(name);
		_util.saveUser(author.id, uData);
		console.log(`{${new Date().toISOString()}} [Space | Create]: ${name} by ${author.username}#${author.discriminator} (${author.id})`);
		return new Space(name);
	}

	delete() {
		this.tags.forEach(t => t.delete());
		fs.unlinkSync(`./_/${this.name}/_meta.json`);
		fs.rmdirSync(`./_/${this.name}`);
		spaces.delete(this.name);
		let uData = _util.getUser(this.author.id);
		uData.spaces.splice(uData.spaces.findIndex(s => s === this.name), 1);
		_util.saveUser(this.author.id, uData);
		console.log(`{${new Date().toISOString()}} [Space | Delete]: ${this.name} by ${this.author.username}#${this.author.discriminator} (${this.author.id})`);
		return undefined;
	}

	createTag([space, name], author, content, options = {}) {
		let newTag = Tag.create([space, name], author, content, options);
		this.addTag(newTag);
		return newTag;
	}

	save(update = true) {
		if (update) this.lastModified = new Date();
		let data = this.toJSON();
		delete data.name;
		fs.writeFileSync(`./_/${this.name}/_meta.json`, _util.stringify(data));
		return this;
	}

	load() {
		let data = JSON.parse(fs.readFileSync(`./_/${this.name}/_meta.json`).toString());
		this.author = data.author === "-1" ? _util.SYSTEM : (client.users.get(data.author) || _util.SYSTEM);
		this.rawTags = Array.from(new Set(_(fs.readdirSync(`./_/${this.name}`)).map(t => t.slice(0, -5)).without('_meta').value()));
		this.contributors = data.contributors.map(u => client.users.get(u) || _util.SYSTEM) || [];
		this.lastModified = new Date(data.lastModified) || new Date();
		this.private = data.private || false;
		this.limited = data.limited || false;
		console.log(`{${new Date().toISOString()}} [Space | Load]: ${this.name} by ${this.author.username}#${this.author.discriminator} (${this.author.id}) with ${this.rawTags.length} tags`);
		this.loadTags();
		return this;
	}

	get random() {
		let _tag = _util.random(this.rawTags);
		return this.getTag(_tag);
	}

	/**
	 * 
	 * @param {Tag} tag 
	 */
	addTag(tag) {
		if (this.tags.has(tag.name)) return false;
		this.tags.set(tag.name, tag);
		if (!this.rawTags.includes(tag.name)) this.rawTags.push(tag.name);
		return this;
	}


	/**
	 * @param {String} id 
	 */
	addContributor(id) {
		if (client.users.has(id)) {
			if (!this.isContributor(id)) {
				let user = client.users.get(id);
				this.contributors.push(user);
				console.log(`{${new Date().toISOString()}} [Space | Edit]: ${user.username}#${user.discriminator} was added to ${this.name}`);
				this.save(false);
			} else {
				return null;
			}
		} else if (id === _util.SYSTEM.id) {
			if (!this.contributors.includes(_util.SYSTEM)) this.contributors.push(_util.SYSTEM);
			console.log(`{${new Date().toISOString()}} [Space | Edit]: SYSTEM#0000 was added to ${this.name}`);
			this.save(false);
		} else {
			return null;
		}

		return this;
	}

	/**
	 * @param {String} id 
	 */
	isContributor(id) {
		return this.contributors.some(u => u.id === id);
	}

	/**
	 * @param {String} id 
	 */
	removeContributor(id) {
		if (this.isContributor(id) && client.users.has(id)) {
			let user = client.users.get(id);
			this.contributors.splice(this.contributors.findIndex(u => u.id === id), 1);
			console.log(`{${new Date().toISOString()}} [Space | Edit]: ${user.username}#${user.discriminator} was removed from ${this.name}.`);
			this.save(false);
		} else if (this.isContributor(id) && id === _util.SYSTEM.id) {
			this.contributors.splice(this.contributors.findIndex(u => u.id === id), 1);
			console.log(`{${new Date().toISOString()}} [Space | Edit]: ${user.username}#${user.discriminator} was removed from ${this.name}.`);
			this.save(false);
		} else {
			return null;
		}

		return this;
	}

	clearContributors() {
		this.contributors.forEach(c => this.removeContributor(c.id));
	}

	transfer(target, keepContributors = false) {
		let prevOwner = client.users.get(this.author.id);
		let prevOwnerData = _util.getUser(this.author.id);
		if (client.users.has(target.id)) {
			let nextOwner = client.users.get(target.id);
			let nextOwnerData = _util.getUser(target.id);
			if (uData.spaces.length <= 5 || _util.isAdmin(id)) {
				// Old Owner
				if (!keepContributors) this.clearContributors();
				this.author = null;
				prevOwnerData.spaces.splice(prevOwnerData.spaces.indexOf(this.name), 1);
				// Log Action
				console.log(`{${new Date().toISOString()}} [Space | Edit]: ${this.name} was transfered from ${prevOwner.username}#${prevOwner.discriminator} to ${nextOwner.username}#${nextOwner.discriminator}`);
				// New Owner
				this.author = nextOwner;
				this.addContributor(nextOwner.id);
				nextOwnerData.spaces.push(this.name);
				this.save(false);
				return true;
			} else {
				return false;
			}
		} else if (_.isEqual(target, _util.SYSTEM)) {
			// Old Owner
			if (!keepContributors) this.clearContributors();
			this.author = _util.SYSTEM;
			this.private = false;
			this.limited = true;
			prevOwnerData.spaces.splice(prevOwnerData.spaces.indexOf(this.name), 1);
			// Log Action
			console.log(`{${new Date().toISOString()}} [Space | Edit]: ${this.name} was transfered from ${prevOwner.username}#${prevOwner.discriminator} to SYSTEM#0000`);
			// New Owner - SYSTEM
			this.author = _util.SYSTEM;
			this.addContributor(this.author.id);
			// Save it
			this.save(true);
			return true;
		} else {
			return null;
		}
	}

	/**
	 * 
	 * @param {String} _t
	 */
	getTag(_t) {
		if (!this.hasTag(_t)) return null;
		let tag = new Tag(_t, this);
		this.tags.set(_t, tag);
		return tag;
	}

	hasTag(t) {
		return this.tags.has(t) || this.rawTags.includes(t);
	}

	deleteTag(_t) {
		if (!this.hasTag(_t)) return false;
		let tag = this.getTag(_t);
		if (this.tags.has(_t)) this.tags.delete(_t);
		if (this.rawTags.includes(_t)) this.rawTags.splice(this.rawTags.indexOf(_t), 1);
		if(fs.existsSync(`./_/${this.name}/${_t}.json`)) fs.unlinkSync(`./_/${this.name}/${_t}.json`);
		console.log(`{${new Date().toISOString()}} [(Space) Tag | Delete]: ${this.name}/${tag.name} by ${tag.author.username}#${tag.author.discriminator}`)
		return true;
	}

	loadTags() {
		this.rawTags.forEach(t => {
			this.tags.set(t, new Tag(t, this));
		})
		return this;
	}

	rename(name) {
		if (spaces.has(name)) return false;
		let uData = _util.getUser(this.author.id);
		fs.renameSync(`./_/${this.name}`, `./_/${name}`);
		spaces.delete(this.name);
		spaces.set(name, this);
		uData.spaces.splice(uData.spaces.indexOf(this.name), 1, name);
		console.log(`{${new Date().toISOString()}} [Space | Edit]: ${this.name} renamed to ${name}`);
		this.name = name;
		_util.saveUser(this.author.id, uData);
		return this;
	}

	toString() {
		return `<Space name=${this.name} tags=${this.rawTags.length} private=${this.private} limited=${this.limited} lastModified=${this.lastModified.toISOString()}>`;
	}

	toJSON() {
		return {
			name: this.name,
			author: this.author.id,
			private: this.private,
			limted: this.limited,
			contributors: this.contributors.map(u => u.id || u).filter(u => !u instanceof String),
			lastModified: this.lastModified.toISOString()
		}
	}
}

class Tag {
	/**
	 * 
	 * @param {String} name 
	 * @param {Space} space 
	 */
	constructor(name, space) {
		/**
		 * @type {String}
		 */
		this.name = name;
		/**
		 * @type {Space}
		 */
		this.space = space;
		this.load();
	}

	static create([space, name], author, content, options = {}) {
		if (!spaces.has(space)) return undefined;
		let data = _util.stringify({
			author: author.id,
			content: content,
			lastModified: Date.now(),
			uses: 0,
			favorites: 0
		});
		fs.writeFileSync(`./_/${space}/${name}.json`, data);
		console.log(`{${new Date().toISOString()}} [Tag | Create]: ${space}/${name} by ${author.username}#${author.discriminator} (${author.id})`);
		return new Tag(name, spaces.get(space));
	}

	save(update = true) {
		if (update) {
			this.lastModified = new Date()
		};
		let data = this.toJSON();
		delete data.name;
		fs.writeFileSync(`./_/${this.space.name}/${this.name}.json`, _util.stringify(data));
		this.space.tags.set(this.name, this);
		return this;
	}

	use(user) {
		this.uses++;
		this.save(false);
		console.log(`{${new Date().toISOString()}} [Tag | Use]: ${this.space.name}/${this.name} by ${user.username}#${user.discriminator} (${user.id})`);
		return this;
	}

	favorite(user) {
		let data = _util.getUser(user.id);
		if (data.favorites.includes(`${this.space.name}/${this.name}`)) {
			let index = data.favorites.findIndex(fav => fav === `${this.space.name}/${this.name}`);
			data.favorites.splice(index, 1);
			this.favorites--;
			console.log(`{${new Date().toISOString()}} [Tag | Unfavorite]: ${user.username}#${user.discriminator} removed ${this.space.name}/${this.name} from their favorites.`);
		} else {
			data.favorites.push(`${this.space.name}/${this.name}`);
			this.favorites++;
			console.log(`{${new Date().toISOString()}} [Tag | Favorite]: ${user.username}#${user.discriminator} added ${this.space.name}/${this.name} to their favorites.`);
		}
		_util.saveUser(user.id, data);

		this.save(false);
		return this;
	}

	load() {
		let data = JSON.parse(fs.readFileSync(`./_/${this.space.name}/${this.name}.json`).toString());
		this.author = data.author === "-1" ? _util.SYSTEM : (client.users.get(data.author) || _util.SYSTEM);
		this.content = data.content || _util["404"];
		this.lastModified = new Date(data.lastModified) || new Date();
		this.uses = data.uses || 0;
		this.favorites = data.favorites || 0;
		return this;
	}

	rename(name) {
		if (this.space.hasTag(name)) return `${_util["403"]} | Name already exists`
		fs.renameSync(`./_/${this.toString()}`, `./_/${this.space.name}/${name}`);
		this.space.tags.delete(this.name);
		this.space.rawTags.splice(this.space.rawTags.findIndex(t => t === this.name));
		this.name = name;
		this.space.tags.set(this.name, this);
		this.space.rawTags.push(this.name);
		this.save();
		console.log(`{${new Date().toISOString()}} [Tag | Edit]: ${this.space.name}/${this.name} renamed to ${this.space.name}/${name}`);
		return this;
	}

	toString() {
		return `<Tag spaceName=${this.space.name} name=${this.name} lastModified=${this.lastModified.toISOString()} uses=${this.uses} favorites=${this.favorites}>`;
	}

	toJSON() {
		return {
			name: this.name,
			author: this.author.id,
			content: this.content,
			lastModified: this.lastModified.toISOString(),
			uses: this.uses,
			favorites: this.favorites
		}
	}

	transfer(target) {
		let prevOwner = client.users.get(this.author.id);
		if (client.users.has(target.id)) {
			let nextOwner = client.users.get(target.id);

		} else if (_.isEqual(target, _util.SYSTEM)) {
			this.author = _util.SYSTEM;
			console.log(`{${new Date().toISOString()}} [Tag | Edit]: ${this.name} was transfered from ${prevOwner.username}#${prevOwner.discriminator} to SYSTEM#0000`);
			this.save(true);
			return true;
		} else {
			return null;
		}
	}
}

const client = new Eris.CommandClient(_config.token, {
	autoreconnect: true,
	disableEveryone: true
}, {
	defaultHelpCommand: true,
	ignoreSelf: true,
	ignoreBots: true,
	name: "Tag[ ]Space",
	description: "A tagbot, nothing more.",
	owner: "PlayTheFallen#8318",
	prefix: ["[T]", "@mention "]
});

/**
 * @type {Map<String, Space>}
 */
let spaces = new Map();
/**
 * @type {Map<String, Object>}
 */
let userData = new Map();

client.registerCommand('eval', async (msg, args) => {
	try {
		let start = msg.createdAt;
		let ev = eval(args.join(" "));
		let end = Date.now();
		if (ev instanceof Promise) await ev;
		if (typeof ev !== 'string')
			ev = util.inspect(ev, {
				depth: 2,
				showHidden: true
			})
		ev = ev.replace(client.token, '1n-r1sk-w3-tru5t');
		if (ev.length > 1000) {
			msg.channel.createMessage('**Output:** Success *with file upload*\nTime: ' + (end - start) / 1000, {
				file: ev,
				name: "evalresult.log"
			});
		} else {
			msg.channel.createMessage('**Output:**\n```js\n' + ev + '```\nTime: ' + (end - start) / 1000);
		}
	} catch (err) {
		if (err.stack.length > 1000) {
			msg.channel.createMessage('**Output:** Failure *with file upload*', {
				file: err.stack,
				name: "evalerror.log"
			});
		} else {
			msg.channel.createMessage('**Output:** Failure\n```js\n' + err.stack + '```');
		}
	}
}, {
	hidden: true,
	requirements: {
		userIDs: ['133659993768591360']
	}
})

client.registerCommand('exec', (msg, args) => {
	let result = childProcess.execSync(args.join(' '));
	msg.channel.createMessage(`**Output:**\n\`\`\`${result}\`\`\``);
	childProcess.exec(args.join(' '), (err, stdout, stderr) => {
		if (err)
			return msg.channel.createMessage(`**Failure:**\n${_code}\n${err}\n${_code}`);
		else if (stderr)
			return msg.channel.createMessage(`**Failure:**\n${_code}\n${stderr}\n${_code}`);
		else
			return msg.channel.createMessage(`**Output:**\n${_code}\n${stdout}\n${_code}`);
	})
}, {
	hidden: true,
	requirements: {
		userIDs: ['133659993768591360']
	}
})

client.registerCommand('limits', "`304`: Moved to `system/limits`.", {
	description: "**MOVED**: Run the command to see the limits of this service."
});

let spaceCommand = client.registerCommand('space', (msg, args) => client.commands['help'].execute(msg, ['space']), {
	aliases: ['s'],
	description: "m8 gimme some space of yours",
	fullDescription: "you have way to much"
})

spaceCommand.registerSubcommand('create', (msg, args) => {
	let spaceName = args.shift();
	let uData = _util.getUser(msg.author.id);
	if (spaces.has(spaceName)) return `${_util["403"]} | Space already exists.`;
	if (uData.spaces.length >= 5) return `${_util["403"]} | You already have 5 spaces.`;
	let options = mimimist(args, {
		boolean: ['private', 'limited'],
		alias: {
			p: 'private',
			c: 'contributors',
			l: 'limited'
		},
		default: {
			private: false,
			contributors: "",
			limited: false
		}
	});
	options.contributors = options.contributors.split(',').filter(c => client.users.has(c));
	let newSpace = Space.create(spaceName, msg.author, options);
	spaces.set(newSpace.name, newSpace);
	uData.spaces.push(newSpace.name);
	_util.saveUser(msg.author.id, uData);
	return `${_util["200"]} | Space \`${newSpace.name}\` created.
**Space Options:**
> Private: ${newSpace.private ? 'Yes' : 'No'}
> Contributors: ${options.contributors.length > 0 ? formatArray(options.contributors.map(c => {let u = client.users.get(c); return `${u.username}#${u.discriminator}`}).filter(u => !util.isNullOrUndefined(u))) : 'No contributors'}
> Limited: ${newSpace.limited ? 'Yes' : 'No'}`;
}, {
	description: "Create your own space.",
	fullDescription: [
		"**[`Usage Explained:`]**",
		"",
		"**Optional Arguments:**",
		"> `p|private`: Whether or not the space should be hidden from searches. (WIP)",
		"> `c|contributors`: Space contributors to add from the start. (WIP)",
		"> `l|limited`: Limited access meaning that only contributors can interact with this space, others can still read what is inside. (WIP)",
		"",
		"**Examples:**",
		"> -p -c 359353569478049792,329729588206764041 -l",
		"> --private --contributors 359353569478049792,329729588206764041 --limited",
		"",
		"**Notes:**",
		"> Extra arguments intended to be part of the name will be discarded in the creation of the space.",
		"> IDs unknown to the bot will be filtered out of the creation process."
	].join('\n'),
	usage: "<name> [(-(-)<key> [value])]"
});

spaceCommand.registerSubcommand('delete', (msg, args) => {
	let _space = args.shift();
	let uData = _util.getUser(msg.author.id);
	if (!spaces.has(_space))
		return _util["404"];
	let space = spaces.get(_space);
	if (!(_util.isAdmin(msg.author.id) || space.author.id === msg.author.id))
		return `${_util["403"]}`;
	space.delete();
	return _util["200"];
}, {
	description: "Delete a space of yours.",
	fullDescription: "You need to be the author of the space. \n**(WARNING: There is no confirm action ...yet)**\nPlease take care when using this.",
	usage: "<space>"
});

spaceCommand.registerSubcommand('edit', (msg, args) => {
	let [_space, action, ...extra] = args;

	// [Checks]
	if (!spaces.has(_space))
		return `${_util["404"]} (Space)`;
	let space = spaces.get(_space);
	if (!(space.author.id === msg.author.id ||
			_util.isAdmin(msg.author.id)))
		return `${_util["403"]} (Permissions)`;

	// [Actions]
	switch (action) {
		case "n":
		case "name":
			// <name>
			{
				let newName = extra.shift();
				space.rename(newName);
				return `${_util["200"]} | Space renamed to \`${newName}\``;
				//return _util["501"];
			}
		case "t":
		case "transfer":
			// @target|targetid|SYSTEM
			{
				let target = (msg.mentions[0] ? msg.mentions[0] :
					client.users.has(args[0]) ? client.users.get(args[0]) : null) || _util.SYSTEM;
				if (!target && target !== _util.SYSTEM)
					return `${_util["404"]} (User)`;
				space.transfer(target);
				return `${_util["200"]} | Transfered \`${_space}\` to ${target.username}#${target.discriminator}`;
			}
		case "c":
		case "contributors":
			{
				let targets = msg.mentions;
				if (!targets.length === 0) return `${_util["401"]}\n> Invaild targets / Targets not found`;
				switch (args.shift()) {
					case "a":
					case "add":
					case "+":
						{
							targets = _.filter(targets, (target) => !space.isContributor(target.id));
							_.each(targets, (target) => space.addContributor(target.id));
							return `${_util["200"]}\n> Added ${formatArray(targets)} as contributors of ${_space}`;
						}
					case "r":
					case "remove":
					case "-":
						{
							targets = _.filter(targets, (target) => space.isContributor(target.id));
							_.each(targets, (target) => space.removeContributor(target.id));
							return `${_util["200"]}\n> Added ${formatArray(targets)} as contributors of ${_space}.`;
						}
					default:
						return `${_util["404"]}`;
				}
			}
		case "p":
		case "private":
			{
				let newValue = _util.resolveBoolean(args.shift());
				if (newValue) return `${_util["404"]}`;
				space.private = newValue;
				space.save()
				return `${_util["200"]} (Set \`private\` to ${space.limited ? 'Yes': 'No'}`;
			}
		case "l":
		case "limited":
			{
				let newValue = _util.resolveBoolean(args.shift());
				if (newValue) return `${_util["404"]}`;
				space.limited = newValue;
				space.save()
				return `${_util["200"]} (Set \`limited\` to ${space.limited ? 'Yes': 'No'}`;
			}
		default:
			return _util["404"];

	}

}, {
	description: "Change your space up. Make it your own.",
	fullDescription: [
		"**[`Usage Explained`]**",
		"",
		"**Resolvers:**",
		"> `true`: `t|true`, `y|yes`, `0`, `+`",
		"> `false`: `f|false`, `n|no`, `1`, `-`",
		// TODO: Transfer resolvers
		//"See `system/resolvers`",
		"",
		"**Action Types:**",
		"> `n|name <newName>` - Change the name of your space. That is if your new one isn't already taken.",
		"> `t|transfer <@target|SYSTEM>` - Is it that time? I'm sure this person will take good care of it.",
		"> `c|contributors <(a|add|+)|(r|remove|-)> <...@target>` - Allow others to help manage the space. (content only, not the space itself).",
		"> `p|private {resolver}` - Should others be allowed to access the content.",
		"> `l|limited {resolver}` - Should others be allowed to contribute their own content to this space? (contributors and existing tag authors will be able to no matter what)",
		"",
		"**Examples:**",
		"None yet...",
		"",
		"**Notes:**",
		"> `t|transfer` will failback to you if the `@target` does not exist or does not have enough space slots in their own profile. (WIP)",
		"  > You can also `t|transfer` it to the system by providing 'SYSTEM' as the transfer target instead. But once it's gone, to someone else, the contributors will be wiped *including SYSTEM*.",
		"> `c|contributors` will be able to access the space no matter the setting for `l|limited` or `p|private`"
	].join('\n'),
	usage: "<space> <{action}> (<...extra>)"
});
spaceCommand.registerSubcommand('info', (msg, args) => {
	return _util["501"];
}, {
	usage: "<space>"
})

client.registerCommand('quote', async (msg, args) => {
	if(msg.author.id !== '133659993768591360') return _util["501"];
	let msgID = args.shift();
	let argv = mimimist(args, {
		alias: {
			c: "channel",
			e: "embed"
		},
		default: {
			channel: msg.channel.id,
			embed: false
		}
	})
	if (!hasPermissions(msg, ['EMBED_LINKS'])) argv.e = argv.embed = false;
	if (!msg.channel.guild.channels.has(argv.c)) argv.c = argv.channel = msg.channel.id;
	let channel = msg.channel.guild.channels.get(argv.c);
	let targetMessage = await channel.getMessage(msgID);
	if (util.isNullOrUndefined(targetMessage)) return `${_util["404"]} (Message ID)`;
	if (argv.e) {
		msg.channel.createMessage({
			embed: {
				author: {
					name: `${targetMessage.author.username}#${targetMessage.author.discriminator}`,
					icon_url: targetMessage.author.avatarURL || targetMessage.author.defaultAvatarURL
				},
				description: targetMessage.content,
				timestamp: targetMessage.timestamp,
				color: Math.floor(Math.random() * 0xFFFFFF),
			}
		})
	} else {
		msg.channel.createMessage([
			`${(a => `**${a.username}#${a.discriminator} (${a.id})**`)(targetMessage.author)} once said:`,
			'-'.repeat(20),
			targetMessage.content.substring(0, 1000),
			'-'.repeat(20)
		].join('\n'))
	}
}, {
	description: "Recall a message?",
	fullDescription: [
		"**[`Usage Explained`]**",
		"",
		"**Options:**",
		"> `<message>` - Your target. (Message ID)",
		"> `c|channel <id>` - Channel to target. (Channel ID)",
		"> `e|embed` - Embed the quote.",
		"",
		"**Todo:**",
		"> Add a `color` option for the embed.",
		"> Add a feature to detect and add message attachments to the embed.",
		"> Add a feature to recognise game application messages / system messages / etc.",
		"> Add a feature to add the quote as a tag in a given space.",
		"",
		"**Notes:**",
		"> This command is guild only.",
		"> `<message>` will fallback to 404, if the target cannot be found.",
		"> `c|channel` will fallback to the current channel, if the target cannot be found.",
		"> `e|embed` will fallback to the default message format."
	].join('\n'),
	guildOnly: true,
	usage: "<message> [-(-)<key> [value]]"
})

let tagCommand = client.registerCommand('tag', (msg, args) => client.commands['help'].execute(msg, ['tag']), {
	aliases: ['t'],
	description: "i want a share of your space"
});

tagCommand.registerSubcommand('create', (msg, args) => {
	let [_space, name] = args.shift().split('\/');
	let content = args.join(' '); //.replace(/[\n\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&');
	if (_util.forbiddenNames.includes(name))
		return _util["403"] + ' | (Name)';
	if (_util.forbiddenChars.some(c => (name || "").includes(c)))
		return _util["403"] + ' | (Chars)';
	if (!spaces.has(_space))
		return `${_util["404"]} | (Space).`;
	let space = spaces.get(_space);
	if ((space.private || space.limited) &&
		!(space.isContributor(msg.author.id) ||
			space.author.id === msg.author.id ||
			_util.isAdmin(msg.author.id)))
		return `${_util["403"]} (Permissions)`;
	if (space.hasTag(name))
		return `${_util["403"]} | Tag \`${name}\` already exists.`;
	if (content.length < 20 && !_util.isAdmin(msg.author.id))
		return `${_util["403"]} | Tag content is too short (${content.length} of 20)`;
	if (content.length > 1500 && !_util.isAdmin(msg.author.id))
		return `${_util["403"]} | Tag content is too long (${content.length}/1500)`;
	space.createTag([_space, name], msg.author, content);
	return `${_util["200"]} | Tag \`${_space}/${name}\` created.`;
}, {
	fullDescription: "**DO NOT ADD A NEW LINE DIRECTLY AFTER THE INTENDED TAG NAME, IT HAS TO BE A SPACE (\\u0020)**",
	usage: "<{space}/{newTag}> <...content>"
});

tagCommand.registerSubcommand('search', (msg, args) => {
	let [_space, ...query] = args;
	if (!spaces.has(_space)) return `${_util["404"]} (Space)`;
	let space = spaces.get(_space);
	if (space.private && !(
			_util.isAdmin(msg.author.id) ||
			space.author.id === msg.author.id ||
			space.isContributor(msg.author.id)))
		return `${_util["403"]} (Permissions)`;
	let tags = [...space.tags.keys()];
	let searchResult = _.chunk(fuzzy.filter(query.join(' '), tags), 50)[0].map(val => val.string);
	msg.channel.createMessage(`**Search results for \`${query.join(' ')}\` in ${_space}:**\n${_code}fix\n${searchResult.join(', ')}\n${_code}`);
}, {
	description: "Shows first 50 tags from search query.",
	usage: "<space> <...query>"
});

tagCommand.registerSubcommand('raw', (msg, args) => {
	let [_space, _tag] = args.shift().split('\/');
	if (!spaces.has(_space)) return `${_util["404"]} | (Space)`;
	let space = spaces.get(_space);
	if (!space.hasTag(_tag)) return `${_util["404"]} | (Tag)`;
	let tag = space.getTag(_tag);
	if (!(_util.isAdmin(msg.author.id) ||
			space.author.id === msg.author.id ||
			space.isContributor(msg.author.id) ||
			tag.author.id === msg.author.id))
		return `${_util["403"]} | (Permissions)`;
	msg.channel.createMessage([
		`**${tag.space.name}/${tag.name}** by **${tag.author.username}#${tag.author.discriminator}**`,
		`**${"-".repeat(20)}`,
		`${_code}js`,
		`${tag.content}`,
		_code,
		`**${"-".repeat(20)}`
	].join('\n'))
}, {
	description: "Useful for editing. (copying is not prefered)",
	fullDescription: "This is restricted to space owners, space contributors and the tag owner.",
	usage: "<{space}/{tag}>"
});

tagCommand.registerSubcommand('list', async (msg, args) => {
	let [_space, page = 1] = args;
	if (page < 1) page = 1;
	if (!spaces.has(_space)) return _util["404"];
	let space = spaces.get(_space);

	if (space.private && !(
			_util.isAdmin(msg.author.id) ||
			space.author.id !== msg.author.id ||
			space.isContributor(msg.author.id)))
		return _util["403"];

	let tags = [...space.tags.keys()];
	let tagPage = _.chunk(tags, 50)[0];
	msg.channel.createMessage(`**Tag[ ]Space \`${_space}\`**\n\`\`\`fix\n${tagPage.join(', ')}\`\`\``); //[\`${page % tagPages.length}\` of \`${tagPages.length}\`]
}, {
	usage: "<{space}>"
});
tagCommand.registerSubcommand('delete', (msg, args) => {
	let [_space, _tag] = args.shift().split('/');
	let uData = _util.getUser(msg.author.id);
	if (!spaces.has(_space)) return _util["404"];
	let space = spaces.get(_space);
	if (!space.hasTag(_tag)) return _util["404"];
	let tag = space.getTag(_tag);
	if (!(tag.author.id === msg.author.id || space.isContributor(msg.author.id) || space.author.id === msg.author.id || _util.isAdmin(msg.author.id))) return `${_util["403"]}`
	space.deleteTag(_tag);
	return `${_util["200"]} | \`${_space}/${_tag}\` was deleted.`
}, {
	usage: "<({space}/{tag})>"
});
tagCommand.registerSubcommand('edit', (msg, args) => {
	let [_space, _tag] = args.shift().split('/');
	let content = args.join(' ');
	if (!spaces.has(_space)) return `${_util["404"]} | TagSpace \`${_space}\` not found.`;
	let space = spaces.get(_space);
	if (!space.hasTag(_tag)) return `${_util["404"]} | Tag \`${_space}/${_tag}\` not found.`;
	let tag = space.getTag(_tag);
	if (!(tag.author.id === msg.author.id ||
			space.isContributor(id) ||
			space.author.id === msg.author.id ||
			_util.isAdmin(msg.author.id)))
		return _util["403"];
	if (content.length < 20 && !_util.isAdmin(msg.author.id))
		return `${_util["403"]} | Tag content is too short (${content.length} of 20)`;
	if (content.length > 1500 && !_util.isAdmin(msg.author.id))
		return `${_util["403"]} | Tag content is too long (${content.length}/1500)`;
	tag.content = content;
	tag.save();
	return `${_util["200"]} | Tag \`${_space}/${_tag}\` edited.`;
}, {
	usage: "<({space}/{tag})> <...content>"
});
tagCommand.registerSubcommand('transfer', (msg, args) => {
	let [_space, _tag] = args.shift('/');
	let target = args[0] === 'SYSTEM' ? null : (msg.mentions[0] ? msg.mentions[0] : null) || _util.SYSTEM;
	if (!spaces.has(_space)) return `${_util["404"]} | TagSpace \`${_space}\` not found.`;
	let space = spaces.get(_space);
	if (!space.hasTag(_tag)) return `${_util["404"]} | Tag \`${_space}/${_tag}\` not found.`;
	let tag = space.getTag(_tag);
	if (!(tag.author.id === msg.author.id ||
			space.isContributor(id) ||
			space.author.id === msg.author.id ||
			_util.isAdmin(msg.author.id)))
		return _util["403"];
	tag.transfer(target);
	return `${_util["200"]} | \`${_space}/${_tag}\` was given to ${tag.author.username}#${tag.author.discriminator}`;
}, {
	description: "Pass the mantel of responsibility to one that may be worthy of your chosen tag.",
	usage: "<{space}/{tag}> <@target|SYSTEM>"
})
tagCommand.registerSubcommand('info', (msg, args) => {
	let [_space, _tag] = args.shift().split('/');
	if (!spaces.has(_space)) return _util["404"];
	let space = spaces.get(_space);
	if (!space.hasTag(_tag)) return _util["404"];
	let tag = space.getTag(_tag);
	if (!(tag.author.id === msg.author.id ||
			space.isContributor(msg.author.id) ||
			space.author.id === msg.author.id) &&
		space.private) return _util["403"];
	return `Tag info for \`${space}/${tag}\` would be here.`;
}, {
	usage: "<({space}/{tag})>"
});
tagCommand.registerSubcommand('favorite', (msg, [action = 'add', ...tags] /* args */ ) => {
	tags = tags.map(t => {
		let [_space, _tag] = t.split('/');
		if (!spaces.has(_space)) return null;
		let space = spaces.get(_space);
		if (!space.hasTag(_tag)) return null;
		return space.getTag(_tag);
	}).filter(t => !util.isNullOrUndefined(t));
	if (['a', 'add', '+'].includes(action)) {
		tags.forEach(t =>
			t.favorite(msg.author));
		return `${_util["200"]} | You added ${tags.length} tags to your favorites.\n> ${tags.map(t => `\`${t.space.name}/${t.name}\``).join(', ')}`;
	} else if (['r', 'remove', '-'].includes(action)) {
		tags.forEach(t =>
			t.favorite(msg.author));
		return `${_util["200"]} | You removed ${tags.length} tags from your favorites\n> ${tags.map(t => `\`${t.space.name}/${t.name}\``).join(', ')}`;
	} else {
		return `${_util["404"]} | Please provide a valid action.`;
	}
}, {
	aliases: ['favourite'],
	description: "(Un)favorite some of your \"good finds\".",
	usage: "<(a|add|+)|(r|remove|-)> <{space}/{tag}> [{space}/{tag}] ..."
});

let myCommand = client.registerCommand('my', (msg) => client.commands['help'].execute(msg, ["my"]), {
	description: "This one doesn't do anything."
})
myCommand.registerSubcommand('favorites', (msg, args) => {
	let uData = _util.getUser(msg.author.id);
	return `**Your favorites (${uData.favorites.length}):**\n${_.chunk(uData.favorites.slice(0, 50), 10).map(arr => `> ${arr.map(t => `\`${t}\``).join(', ')}`).join('\n')}`;
}, {
	aliases: ['favourites'],
	description: "Get all your favorites in one place. (pages soon:tm:, will only show first 50 at best)",
	//usage: ""
});
myCommand.registerSubcommand('spaces', (msg, args) => {
	let uData = _util.getUser(msg.author.id);
	return `**Your spaces (${uData.spaces.length}):**\n${uData.spaces.map(s => `> \`${s}\``).join('\n')}`;
}, {
	description: "Get all your spaces in one place.",
	//usage: "[page]"
});
myCommand.registerSubcommand('tags', (msg, args) => {
	let uData = _util.getUser(msg.author.id);
	let _spaceCount = 0;
	let tags = _([...[...spaces.values()].map(space => [...space.tags.values()])].map(tags => tags.filter(t => t.author.id === msg.author.id))).flatten().chunk(50).value()[0].map(t => `${t.space.name}/${t.name}`);
	return `**Your tags (${tags.length} across ${_spaceCount}):**\n${_code}fix\n${tags.join(', ')}\n${_code}`;
}, {
	description: "not yet, sorry... (will only show first 50 at best)",
	//usage: "[page]"
})

client.registerCommand('ping', ["Pang!", "Peng!", "Ping!", "Pong!", "Pung!"], {
	description: "Pong!",
	fullDescription: "This command could be used to check if the bot is up. Or entertainment when you're bored."
});

function getStats() {
	return {
		guilds: client.guilds.size,
		guildChannels: Object.keys(client.channelGuildMap).length,
		guildEmojis: client.guilds.map(g => Object.keys(g.emojis).length).reduce((p, c) => p + c, 0),
		guildEmojisAnimated: client.guilds.map(g => Object.values(g.emojis).filter(e => e.animated).length).reduce((p, c) => p + c, 0),
		guildRoles: client.guilds.map(g => g.roles.size).reduce((p, c) => p + c, 0),
		users: client.users.size,
		uHumans: client.users.filter(u => !u.bot).length,
		uAndroids: client.users.filter(u => u.bot).length,
		userDMs: client.privateChannels.size,
		shards: client.shards.size
	}
}

function formatArray(arr) {
	var outStr = "";
	if (arr.length === 1) {
		outStr = arr[0];
	} else if (arr.length === 2) {
		//joins all with "and" but no commas
		//example: "bob and sam"
		outStr = arr.join(' and ');
	} else if (arr.length > 2) {
		//joins all with commas, but last one gets ", and" (oxford comma!)
		//example: "bob, joe, and sam"
		outStr = arr.slice(0, -1).join(', ') + ', and ' + arr.slice(-1);
	}
	return outStr;
}

let stats;

client.registerCommand('info', () => [
	"**`Tag[ ]Space` Information**",
	"Made by PlayTheFallen (Fallen)",
	"",
	"**`Tag[ ]Space` Stats**",
	`  > **Spaces:** ${spaces.size}`,
	`  > **Guilds:** ${stats.guilds}`,
	`    > **Channels:** ${stats.guildChannels}`,
	`    > **Emojis:** ${stats.guildEmojis}`,
	`      > **Animated:** ${stats.guildEmojisAnimated}`,
	`    > **Roles:** ${stats.guildRoles}`,
	`  > **Users:** ${stats.users}`,
	`    >> **Open DMs:** ${stats.userDMs}`,
	`    > **Humans:** ${stats.uHumans}`,
	`    > **Androids:** ${stats.uAndroids}`,
	`  > **Shards:** ${stats.shards}`
].join('\n'), {
	description: "just some info about me"
});

client.registerCommand('sandbox', async (msg, args) => {
	try {
		let evaled = new vm.VM({
			timeout: 5000,
			sandbox: {
				_: _,
				_200: _util["200"],
				_401: _util["401"],
				_403: _util["403"],
				_404: _util["404"],
				_501: _util["501"],
				random: _util.random,
				util: util,
				assert: require('assert'),
				crypto: require('crypto'),
				zlib: require('zlib')
			}
		}).run(args.join(' '));
		if (evaled instanceof Promise)
			await evaled;
		if (typeof evaled !== "string")
			evaled = util.inspect(evaled, true, true);

		client.createMessage(msg.channel.id, `**Success**\n${_code}js\n${evaled}\n${_code}`);
	} catch (e) {
		client.createMessage(msg.channel.id, `**Failure**\n${_code}js\n${e.stack}\n${_code}`);
	}
}, {
	description: "A javascript code sandbox. (Self contained, open to all)",
	fullDescription: [
		"Script will timeout after 5 seconds.",
		"**Variables included:**",
		"> `random(arr: *[] | Array<*>): *`",
		">  `200`, `401`, `403`, `404` and `501` status messages used by the bot registered as `_{status}`.",
		"> `_code` shorthand codeblock wrapper. (useful for template strings)",

		"**Included Modules:**",
		"> Lodash (4.17.10) as `_`",
		"> `assert`, `crypto`, `util`, `zlib` - modules of nodejs",
	].join('\n')
})

client.registerCommand('invite', [
	`Tag[ ]Space is an invite-only bot.`,
	`Please ask PlayTheFallen#8318 for more details on this.`
].join('\n'), {
	description: "Invite me? Good luck with that. :laughing:",
	fullDescription: "Invite me? Good luck with that. :laughing:"
})

client.connect();

/**
 * 
 * @param {external:Eris.Message} msg 
 * @param {String[]} perms 
 */
function hasPermissions(msg, perms) {
	return perms.every(p => msg.channel.permissionsOf(client.user.id).has(p));
}

client.on('messageCreate', (msg) => {
	if (client.user.id === msg.author.id || _util.getUser(msg.author.id).isBanned) return;
	if (client.commandOptions.prefix.some(prefix => msg.content.startsWith(prefix))) {
		let uData = _util.getUser(msg.author.id);
		_util.saveUser(msg.author.id, uData);
		return console.log(`{${new Date(msg.timestamp).toISOString()}} [Command]: ${msg.author.username}#${msg.author.discriminator} ${~msg.channel.guild ? `| ${msg.channel.guild.name} | ${msg.channel.name}`: ``}\n\t> ${msg.content}`);
	}
	let tags = msg.content.match(_util.tagRegex) || [];
	if (tags.length > 0) {
		// only allow first 5 per message
		let finalTags = tags.map(t =>
				t.substring(2, t.length - 1))
			.map(t => {
				let [_space, _tag] = t.split('/');
				if (!spaces.has(_space)) return undefined;
				let space = spaces.get(_space);
				if (!space.hasTag(_tag)) return undefined;
				let tag = space.getTag(_tag);
				if (space.private && !(tag.author.id === msg.author.id ||
						space.isContributor(msg.author.id) ||
						space.author.id === msg.author.id ||
						_util.isAdmin(msg.author.id)))
					return undefined;
				return tag;
			}).filter(Boolean);
		finalTags = _.take(finalTags, 5);
		_.each(finalTags, t => {
			msg.channel.createMessage([
				`**${t.space.name}/${t.name}** by **${t.author.username}#${t.author.discriminator}**`,
				`**${"-".repeat(20)}**`,
				`${t.content}`,
				`**${"-".repeat(20)}**`
			].join('\n')) && t.use(msg.author);
		})
		// msg.channel.createMessage("**Tags Recognised:**\n" + tags.join('\n'));
		console.log(`{${new Date(msg.timestamp).toISOString()}} [Regex]: ${msg.author.username}#${msg.author.discriminator} ${~msg.channel.guild ? `| ${msg.channel.guild.name} | ${msg.channel.name}`: ``}\n\t> ${finalTags.map(t => `${t.space.name}/${t.name}`).join(', ')}`);
		return;
	}
})

function reloadEverything() {
	console.log(`{${new Date().toISOString()}} [ADMIN] Reloading all content.`);
	console.log(`-`.repeat(30));
	fs.readdirSync('./userData').forEach(file =>
		userData.set(file.replace(/.json$/, ''), JSON.parse(fs.readFileSync(`./userData/${file}`))))
	fs.readdirSync('./_').forEach(space =>
		spaces.set(space, new Space(space)));
}

client.on('ready', () => {
	client.editStatus('online', {
		name: "all of time and space. | [T]help",
		type: 3
	})
	reloadEverything();
	stats = getStats();
	setInterval(() => stats = getStats(), 1000 * 60 * 10);
})

client.connect();