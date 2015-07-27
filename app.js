
angular.module('DeviceStatusApp', ['tmCloudClient', 'AuthMixin'], function($provide) {
		$provide.value('endpoint', 'http://http.cloud.tiny-mesh.com:8080');
	})
	.config(['$httpProvider', function($httpProvider) {
		$httpProvider.defaults.timeout = 60000;
	}])
	.controller('DeviceStatusController', function(
		$scope,
		$location,
		$q,
		$localStorage,
		tmNet,
		tmMsgQuery) {

		// used by spin.js
		$scope.loading = true
		$scope.timezone = -330; // +05:30 - IST


		// helper function for dealing with search parameters
		$scope.params = {}
		$scope.param = function(k, v) {
			if (undefined !== v) {
				$scope.params[k] = v
				$location.search(k, v)
			}

			return $location.$$search[k]
		}


		// helper function checking if search parameter matches
		$scope.matches = function(k, v, emptyok) {
			return $scope.params[k] == v || (!$scope.params[k] && emptyok)
		}


		// check if input `val` exists in `list`
		$scope.member = function(val, list, isInt) {
			if (isInt)
				val = parseInt(val)

			return -1 !== _.indexOf(list, val)
		}


		// Helper to provide sorting with reverse option
		$scope.reverse = 'true' === $scope.param('reverse')
		$scope.predicate = $scope.param('predicate') || "key"
		$scope.sort = function(predicate) {
			if (predicate === $scope.predicate) {
				$scope.reverse = !$scope.reverse
				$scope.param('reverse', $scope.reverse ? 'true' : 'false')
			} else {
				$scope.reverse = false
				$scope.param('reverse', 'false')
			}

			$scope.param('predicate', $scope.predicate = predicate)
		}

		// check that a date is valid
		$scope.validDate = function(date) {
			if (!date)
				return false

			return null !== date.match(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
		}

		// Set the parameters
		$scope.networks = [] // list of available networks
		$scope.network = {} // active network
		$scope.devicemap = [] // array version of network.devicemap to enable sorting
		$scope.devicekeys = {} // lookup table for .devicemap
		$scope.channelcount = 0; // quick lookup of channel size
		$scope.now = new Date()

		// compute start of this week
		var _currentWeek = new Date().setDate($scope.now.getDate() - $scope.now.getDay() + 1);
		$scope.currentWeek = (new Date(_currentWeek - (_currentWeek % 86400000))).getTime()


		var formatDate = function(date) {
			if ('function' !== typeof date)
				date = new Date(date)

			return [date.getUTCFullYear(),
				("00" + (date.getUTCMonth() + 1)).slice(-2, 3),
				("0" + date.getUTCDate()).slice(-2, 3)].join('-')
		}

		// computes list of weeks since `created`
		var weekGenerator = function(created) {
			var
				weeks = [],
				now = new Date(),
				deploydate = new Date(created),
				firstWeek = new Date(created)

			firstWeek.setDate(deploydate.getDate() - deploydate.getDay() + 1)

			numWeeks = Math.floor((now.getTime() - firstWeek.getTime()) / 1000 / 86400 / 7)

			for (i = 0; i <= numWeeks; i++) {
				weeks.push(formatDate(new Date(firstWeek.getTime() + (86400000 * 7 * i))))
			}

			weeks.reverse()
			return weeks
		}

		// lock used by queryData
		var lock

		// Set the network resource
		$scope.setNetwork = function(network, doQuery) {
			if (!network)
				return

			doQuery = undefined === doQuery ? true : doQuery

			network.types.all = [];

			// temporarily hardcode this
			if ("SI1" === network.key)
				network.meta.created = "2015-02-24T00:00:00.000000Z"
			if ("SI3" === network.key)
				network.meta.created = "2015-03-20T00:00:00.000000Z"
			if ("SI4" === network.key)
				network.meta.created = "2015-03-31T00:00:00.000000Z"
			if ("SHQ" === network.key)
				network.meta.created = "2015-01-23T00:00:00.000000Z"
			if ("SIF" === network.key)
				network.meta.created = "2015-06-08T00:00:00.000000Z"

			// allow copying of url
			$scope.param('network', network.key)

			angular.copy(network, $scope.network)
			// reset computed variables
			$scope.devicemap = []
			$scope.devicekeys = {}

			$scope.weeks = weekGenerator(network.meta.created)


			// add all the devices to the list, skipping gateways
			_.each(network.devicemap, function(input, key) {
				var dev = {
					key: key,
					address: input.address,
					name: input.name,
					type: input.type,
					msgs: {},
					nDays: 0, // days with data in selected query
					energy: {
						saved: 0,
						savedWh: 0,
						wattage: [7.5, 7.5, 7.4], // wattage [avg, min, max]
						consumption: {}, // <date> => consumption
						avgConsumption: [0, 0, 0], // consumption [avg, min, max]
					},
					meta: {
						lastMsg: 0,
						powerStatus: 'unknown'
					}
				};

				// add device to `devicemap` with correct mapping in `devicekeys`
				var pos = $scope.devicemap.push(dev) - 1
				$scope.devicekeys[dev.key] = pos
			})


			$scope.loading = false
			if (doQuery)
				$scope.queryData(network.key, $scope.param('starttime'))
		}

		// perform the data query
		var
			defaultQueryLength = 7,
			defaultIMATime = 5,
			voltFactor = 29.75,
			currentFactor = 1

		// store the cached so it can be cleared
		var maybeLookupCache = function(query) {
			var
				defered,
				cacheKey =  query.network + '_' + query['date.from'] + "_" + query['date.to'],
				res = $localStorage[cacheKey]

			if (undefined === res)
				return tmMsgQuery.query(query)

			// return the resolved promise
			defered = $q.defer()
			defered.resolve(JSON.parse(LZString.decompress(res)))

			return {$promise: defered.promise}
		}

		$scope.queryData = function(network, starttime, length) {
			length = length || defaultQueryLength

			var
				startpoint = new Date(starttime || formatDate($scope.currentWeek));

			// correct for timezone differences
			startpoint.setMinutes(startpoint.getMinutes() + $scope.timezone)

			$scope.loading = true

			// lock it to make sure old queries don't overwrite new timeranges
			var lockref = lock = Math.random()
			var refcounter = length;


			// split up into multiple queries to speed up everything
			// and add caching for old data
			_.each(new Array(length), function(v, i) {
				var
					from = new Date(startpoint),
					to = new Date(from)

				from.setDate(startpoint.getDate() + i)
				to.setDate(startpoint.getDate() + i + 1)

				var q,
					_from = from.toISOString(),
					_to = to.toISOString(),
					res = maybeLookupCache(q={
						'network': network,
						'device': '',
						'date.from': _from,
						'date.to':   _to,
						'filter.pick': "proto/tm.aio0,proto/tm.aio1",
						'query': 'proto/tm.type:event',
						'sort.by': 'datetime'
				})	  ;

				var cacheKey = network + '_' + _from + "_" + _to

				res.$promise.then(function(resp) {
					// if this is a response for a different query skip it
					if (lockref !== lock)
						return

					if (0 === --refcounter)
						$scope.loading = false

					_.each(resp.result, function(msg) {
						var proto = msg['proto/tm']

						// only ima messages counts as online time, nid is
						// used to calculate reconnects... skip all other messages
						if ('ima' !== proto.detail && 'nid' !== proto.detail)
							return

						// correct for timezone
						var datetime = new Date(msg.datetime)

						datetime.setMinutes(datetime.getMinutes() - $scope.timezone)

						var dateparts = datetime.toISOString().match(/^([^T]*)T(..):(..).*$/, '')

						// find devicekeys
						var idx = $scope.devicekeys[msg.selector[1]]

						// build msgs structure:
						// msgs[<date>][<hour>] = [min1, min.., minN]
						// this allows us to quickly aggregate hourly
						// consumption by just counting the <hour> array
						// and daily or multi-day counts can easily be done
						// by _.flattenDeep(msgs[<date>])
						var
							dev = $scope.devicemap[idx],
							msgs = dev.msgs
						if (!msgs[dateparts[1]])
							msgs[dateparts[1]] = {}

						if (!msgs[dateparts[1]][dateparts[2]])
							msgs[dateparts[1]][dateparts[2]] = []




						// Add re-connect messages 
						if ('nid' === proto.detail) {
							msgs[dateparts[1]][dateparts[2]].push(null)
							return
						} else if (dev.type === 'gateway') {
							return
						}




						var
							voltage = ((proto.aio0 * 1.25 / 2047) * voltFactor),
							current = (proto.aio1 * 1.25 / 2047) * currentFactor,
							wattage = (voltage * current) / 0.85,
							saved = 60 - wattage

						dev.energy.saved += saved
						dev.energy.savedWh += saved / (60 / defaultIMATime)
						if (wattage > 7.8)
						     wattage = 7.6
						  if (6.6 > wattage)
							wattage=6.7


						// set wattage avgerage, min, max
						if (!dev.energy.wattage[1] || dev.energy.wattage[1] > wattage)
							dev.energy.wattage[1] = wattage

						if (dev.energy.wattage[2] < wattage)
							dev.energy.wattage[2] = wattage

						dev.energy.wattage[0] = (dev.energy.wattage[0] + wattage) / 2

						// increase consumption
						if (!dev.energy.consumption[dateparts[1]])
							dev.energy.consumption[dateparts[1]] = 0

						dev.energy.consumption[dateparts[1]] += defaultIMATime

						msgs[dateparts[1]][dateparts[2]].push({
							datetime: datetime.toISOString(),
							voltage: voltage,
							current: current,
							wattage: wattage,
							saved: saved
						})

						if (datetime.getTime() > dev.meta.lastMsg) {
							var now = new Date().getTime()
							dev.meta.lastMsg = datetime.getTime()
							dev.meta.powerStatus = (now - 900000 > dev.meta.lastMsg) ? 'offline' : 'online'
						}
					})

					// compute average,min,max consumption
					_.each($scope.devicekeys, function(idx) {
						var dev = $scope.devicemap[idx]
						dev.energy.avgConsumption = [
							(_.sum(_.values(dev.energy.consumption)) / _.size(dev.energy.consumption) / 60) || 0,
							(_.min(_.values(dev.energy.consumption)) / 60) || 0,
							(_.max(_.values(dev.energy.consumption)) / 60) || 0
						]
						dev.nDays = _.size(dev.msgs)
					});

					return resp
				})

				// save old data to cache
				res.$promise.then(function(resp) {
					var diff = new Date().getTime() - to.getTime()

					// if data is newer than two days we don't save it
					if (diff < 86400000*2)
						return resp

					if (undefined === $localStorage[cacheKey]) {
						$localStorage[cacheKey] = LZString.compress(JSON.stringify(resp))
						$localStorage._cache = $localStorage._cache || []
						$localStorage._cache.push(cacheKey)
					}

					return resp
				})

			})
		}

		$scope.clearCache = function() {
			_.each($localStorage._cache, function(v, i) {
				console.log('cache: purge ' + v)
				delete $localStorage[v]
				delete $localStorage._cache[i]
			})
			$localStorage._cache = []
		}


		// check reconnects in the last hour
		$scope.DCUInfo = function(key) {
			var idx = $scope.devicekeys[key]
			var connects = _.reduce($scope.devicemap[idx].msgs, function(acc, hours, day) {
				_.each(hours, function(v, hour) {
					acc[day + "T" + hour] = v.length
				});
				return acc
			}, {})

			var now = new Date();
			// correct for timezone differences
			now.setMinutes(now.getMinutes() - $scope.timezone)

			lastreconns = _.map(new Array(24), function(v, k) {
				var then = new Date(now);
				then.setMinutes(then.getMinutes() - 60*k)
				return connects[(then.toISOString().replace(/:.*$/, ''))] || 0
			})

			return {
				connections: connects,
				connections24h: _.sum(lastreconns)
			}
		}

		$scope.expanded = {}

		$scope.expand = function(key) {
			if (undefined !== $scope.expanded[key])
				delete $scope.expanded[key]
			else
				$scope.expanded[key] = $scope.devicemap[$scope.devicekeys[key]]
		}


		// populates network list
		var constructor = function() {
			// copy url parameters to app
			_.each($location.$$search, function(v, k) {
				$scope.param(k, v)
			})

			tmNet.list()
				.$promise.then(function(networks) {
					angular.copy(networks, $scope.networks)

					// if there's a network in the query parameters set it
					if ($scope.param('network'))
						$scope.setNetwork( _.where(networks, {key: $scope.param('network')})[0] )
				})
		}

		constructor();

	})
	.filter('wattage', function() {
		return function(items) {
			return 0
		}
	})
	.filter('onlineTime', function() {
		return function(items) {
			return 0
		}
	})
	.filter('energySaved', function() {
		return function(items) {
			return 0
		}
	})
	.filter('reconnects', function() {
		return function(items) {
			return 0
		}
	})
	.filter('statusText', function() {
		var statuses = {
			'all':'All',
			'online': 'Online',
			'offline': 'Offline',
			'unknown':'Unknown'
		}

		return function(status) {
			return statuses[status];
		}
	})
	.filter('timezoneText', function() {
		return function(timezone) {
			return (timezone <= 0 ? "+" : "-") +
				Math.floor(-1 * timezone / 60) +
				":" +
				(((-1 * timezone / 60) % 1) * 60);
		}
	})
	.filter('weekText', function() {
		return function(starttime, weeks) {
			if (!starttime || !weeks)
				return

			if (!starttime || starttime === weeks[0]) {
				return 'this week';
			} else if (starttime === weeks[1]) {
				return 'last week';
			} else  {
				var date = new Date(starttime)
				var date2 = new Date(starttime);
				date2.setDate(date.getDate() + 7)

				var from = [
					date.getUTCFullYear(),
					("00" + (date.getUTCMonth() + 1)).slice(-2, 3),
					("0" + date.getUTCDate()).slice(-2, 3)
				].join("-");

				var to = [
					date2.getUTCFullYear(),
					("00" + (date2.getUTCMonth() + 1)).slice(-2, 3),
					("0" + date2.getUTCDate()).slice(-2, 3)
				].join("-");

				return from + " to " + to;
			}
		};
	})
	.filter('address', function() {
		return function(val, opts, bigendian) {
			var buf;
			bigendian = bigendian || false;

			addr = _.filter(("00000000" + parseInt(val, 10).toString(16))
					.substr(-8)
					.split(/(..)/), function(x) { return x !== ''; });
			switch (opts.encoding || "hex") {
				case "hex":
					return (bigendian ? addr : addr.reverse()).join(":");

				case "bytes":
					addr = _.map(addr, function(x) { return parseInt(x, 16); });
					return (bigendian ? addr : addr.reverse()).join('.');

				default:
					return val;
			}
		};
	})
	.filter('fuzzyDate', function() {
		/*
		 * JavaScript Pretty Date
		 * Copyright (c) 2011 John Resig (ejohn.org)
		 * Licensed under the MIT and GPL licenses.
		 */

		// Takes an ISO time and returns a string representing how
		// long ago the date represents.
		return function(time){
			var date = new Date((time || "")),
				diff = (((new Date()).getTime() - date.getTime()) / 1000),
				day_diff = Math.floor(diff / 86400);

			if ( isNaN(day_diff) || day_diff < 0 || day_diff >= 31 ) {
				return undefined;
			}

			return day_diff === 0 && (
					diff < 60 && "just now" ||
					diff < 240 && "few minutes ago" ||
					diff < 3600 && Math.floor( diff / 60 ) + " minutes ago" ||
					diff < 7200 && "1 hour ago" ||
					diff < 86400 && Math.floor( diff / 3600 ) + " hours ago") ||
				day_diff === 1 && "Yesterday" ||
				day_diff < 7 && day_diff + " days ago" ||
				day_diff < 31 && Math.ceil( day_diff / 7 ) + " weeks ago" ||
				day_diff < 365 && Math.ceil( day_diff / 31 ) + " months ago" ||
				day_diff > 365 && Math.ceil( day_diff / 365 ) + " years ago";
		};
	})
	.directive('tmSpinner', function() {
		return {
			restrict: 'A',
			replace: true,
			transclude: true,
			scope: {
				loading: '=tmSpinner'
			},
			template: '\
				<div>\
					<div ng-show="loading" id="spinner-container">\</div>\
					<h5 ng-show="loading" style="padding-top:70px;font-weight:bold;"><center>loading ...</center></h5>\
					<div ng-hide="loading" ng-transclude></div>\
				</div>\
			',
			link: function(scope, element, attrs) {
				var spinner = new Spinner({
						lines: 9, // The number of lines to draw
						length: 6, // The length of each line
						width: 6, // The line thickness
						radius: 33, // The radius of the inner circle
						corners: 1, // Corner roundness (0..1)
						rotate: 0, // The rotation offset
						direction: 1, // 1: clockwise, -1: counterclockwise
						color: '#ccc', // #rgb or #rrggbb or array of colors
						speed: 0.7, // Rounds per second
						trail: 100, // Afterglow percentage
						shadow: false, // Whether to render a shadow
						hwaccel: false, // Whether to use hardware acceleration
						className: 'spinner', // The CSS class to assign to the spinner
						zIndex: 2e9, // The z-index (defaults to 2000000000)
						top: '230', // Top position relative to parent
						left: '50%' // Left position relative to parent
					}).spin()
				loadingContainer = document.getElementById('spinner-container')
				loadingContainer.appendChild(spinner.el)
			}
		}
	})
