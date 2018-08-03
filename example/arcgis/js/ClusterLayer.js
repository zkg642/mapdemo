define([
  "dojo/_base/declare",
  "dojo/_base/array",
  "esri/Color",
  "dojo/_base/connect",

  "esri/SpatialReference",
  "esri/geometry/Point",
  "esri/graphic",
  "esri/symbols/SimpleMarkerSymbol",
  "esri/symbols/TextSymbol",

  "esri/dijit/PopupTemplate",
  "esri/layers/GraphicsLayer"
], function (
  declare, arrayUtils, Color, connect,
  SpatialReference, Point, Graphic, SimpleMarkerSymbol, TextSymbol,
  PopupTemplate, GraphicsLayer
) {
    return declare([GraphicsLayer], {
      constructor: function (options) {
        // options:
        //   data:  Object[]
        //     Array of objects. Required. Object are required to have properties named x, y and attributes. The x and y coordinates have to be numbers that represent a points coordinates.
        //   distance:  Number?
        //     Optional. The max number of pixels between points to group points in the same cluster. Default value is 50.
        //   labelColor:  String?
        //     Optional. Hex string or array of rgba values used as the color for cluster labels. Default value is #fff (white).
        //   labelOffset:  String?
        //     Optional. Number of pixels to shift a cluster label vertically. Defaults to -5 to align labels with circle symbols. Does not work in IE.
        //   resolution:  Number
        //     Required. Width of a pixel in map coordinates. Example of how to calculate: 
        //     map.extent.getWidth() / map.width
        //   showSingles:  Boolean?
        //     Optional. Whether or graphics should be displayed when a cluster graphic is clicked. Default is true.
        //   singleSymbol:  MarkerSymbol?
        //     Marker Symbol (picture or simple). Optional. Symbol to use for graphics that represent single points. Default is a small gray SimpleMarkerSymbol.
        //   singleTemplate:  PopupTemplate?
        //     PopupTemplate</a>. Optional. Popup template used to format attributes for graphics that represent single points. Default shows all attributes as "attribute = value" (not recommended).
        //   maxSingles:  Number?
        //     Optional. Threshold for whether or not to show graphics for points in a cluster. Default is 1000.
        //   webmap:  Boolean?
        //     Optional. Whether or not the map is from an ArcGIS.com webmap. Default is false.
        //   spatialReference:  SpatialReference?
        //     Optional. Spatial reference for all graphics in the layer. This has to match the spatial reference of the map. Default is 102100. Omit this if the map uses basemaps in web mercator.

        this._clusterTolerance = options.distance || 50;
        this._clusterData = options.data || [];
        this._clusters = [];
        this._clusterLabelColor = options.labelColor || "#000";
        // labelOffset can be zero so handle it differently
        this._clusterLabelOffset = (options.hasOwnProperty("labelOffset")) ? options.labelOffset : -5;
        // graphics that represent a single point
        this._singles = []; // populated when a graphic is clicked
        this._showSingles = options.hasOwnProperty("showSingles") ? options.showSingles : true;
        // symbol for single graphics
        var SMS = SimpleMarkerSymbol;
        this._singleSym = options.singleSymbol || new SMS("circle", 6, null, new Color("#888"));
        this._singleTemplate = options.singleTemplate || new PopupTemplate({ "title": "", "description": "{*}" });
        this._maxSingles = options.maxSingles || 1000;

        this._webmap = options.hasOwnProperty("webmap") ? options.webmap : false;

        this._sr = options.spatialReference || new SpatialReference({ "wkid": 102100 });

        this._zoomEnd = null;
        //新增属性
        this._maxZoom = options.maxZoom || 12;
        this._map = null;
      },

      // override esri/layers/GraphicsLayer methods 重写setMap方法
      _setMap: function (map, surface) {
        // calculate and set the initial resolution 计算和设置初始分辨率
        this._clusterResolution = map.extent.getWidth() / map.width; // probably a bad default...
        this._map = map;//将map设置为全局变量
        this._clusterGraphics();//聚类

        // connect to onZoomEnd so data is re-clustered when zoom level changes当缩放级别改变时数据会重新聚集。
        this._zoomEnd = connect.connect(map, "onZoomEnd", this, function () {
          // update resolution
          this._clusterResolution = this._map.extent.getWidth() / this._map.width;
          this.clear();//清除
          this._clusterGraphics(); //重新聚类
        });

        // GraphicsLayer will add its own listener here
        var div = this.inherited(arguments);
        return div;
      },

      _unsetMap: function () {
        this.inherited(arguments);
        connect.disconnect(this._zoomEnd);
      },

      // public ClusterLayer methods
      add: function (p) {
        // Summary:  The argument is a data point to be added to an existing cluster. If the data point falls within an existing cluster, it is added to that cluster and the cluster's label is updated. If the new point does not fall within an existing cluster, a new cluster is created.
        //
        // if passed a graphic, use the GraphicsLayer's add method
        if (p.declaredClass) {
          this.inherited(arguments);
          return;
        }

        // add the new data to _clusterData so that it's included in clusters
        // when the map level changes
        this._clusterData.push(p);
        var clustered = false;
        // look for an existing cluster for the new point
        for (var i = 0; i < this._clusters.length; i++) {
          var c = this._clusters[i];
          if (this._clusterTest(p, c)) {
            // add the point to an existing cluster
            this._clusterAddPoint(p, c);
            // update the cluster's geometry
            this._updateClusterGeometry(c);
            // update the label
            this._updateLabel(c);
            clustered = true;
            break;
          }
        }

        if (!clustered) {
          this._clusterCreate(p);
          p.attributes.clusterCount = 1;
          this._showCluster(p);
        }
      },

      clear: function () {
        // Summary:  Remove all clusters and data points.
        this.inherited(arguments);
        this._clusters.length = 0;
      },

      clearSingles: function (singles) {
        // Summary:  Remove graphics that represent individual data points.
        var s = singles || this._singles;
        arrayUtils.forEach(s, function (g) {
          this.remove(g);
        }, this);
        this._singles.length = 0;
      },

      onClick: function (e) {
        // remove any previously showing single features
        this.clearSingles(this._singles);

        // find single graphics that make up the cluster that was clicked
        // would be nice to use filter but performance tanks with large arrays in IE
        var singles = [];
        for (var i = 0, il = this._clusterData.length; i < il; i++) {
          if (e.graphic.attributes.clusterId == this._clusterData[i].attributes.clusterId) {
            singles.push(this._clusterData[i]);
          }
        }
        //如果聚类点的个数大于1

        if (singles.length > this._maxSingles || singles.length > 1) {
          // alert("Sorry, that cluster contains more than " + this._maxSingles + " points. Zoom in for more detail.");
          // var level = this._map.getLevel();
          var level = this._map.getLevel() + 2 >= 17 ? 17 : this._map.getLevel() + 2;
          this._map.setZoom(level);
          this._map.centerAt(e.graphic.geometry);
        } else {
          // stop the click from bubbling to the map
          e.stopPropagation(); //阻止map的冒泡事件
          this._map.infoWindow.show(e.graphic.geometry);
          this._addSingles(singles);
        }
      },

      // internal methods 内部方法
      _clusterGraphics: function () {
        // first time through, loop through the points 遍历所有数据
        for (var j = 0, jl = this._clusterData.length; j < jl; j++) {
          // see if the current feature should be added to a cluster
          var point = this._clusterData[j];
          //状态
          var clustered = false;
          //遍历聚类数据
          for (var i = 0; i < this._clusters.length; i++) {
            var c = this._clusters[i];
            //如果为true,就push到同一个数组中
            if (this._clusterTest(point, c)) {
              this._clusterAddPoint(point, c);
              clustered = true;
              break;
            }
          }

          if (!clustered) {
            //如果不为真，将点push到要聚类的数组中
            this._clusterCreate(point);
          }
        }
        this._showAllClusters();
      },
      //判断点是否需要聚类
      _clusterTest: function (p, cluster) {
        //计算距离
        var distance = (
          Math.sqrt(
            Math.pow((cluster.x - p.x), 2) + Math.pow((cluster.y - p.y), 2)
          ) / this._clusterResolution
        );
        var _flag = (distance <= this._clusterTolerance);
        var _level = this._map.getZoom();
        if (_level >= this._maxZoom) _flag = false;
        return _flag;
      },

      // points passed to clusterAddPoint should be included 
      // in an existing cluster
      // also give the point an attribute called clusterId 
      // that corresponds to its cluster
      //将point加到cluster数组中
      _clusterAddPoint: function (p, cluster) {
        // average in the new point to the cluster geometry
        var count, x, y;
        count = cluster.attributes.clusterCount;
        //重新计算cluster对象的x,y,总数
        x = (p.x + (cluster.x * count)) / (count + 1);
        y = (p.y + (cluster.y * count)) / (count + 1);
        cluster.x = x;
        cluster.y = y;

        // build an extent that includes all points in a cluster
        // extents are for debug/testing only...not used by the layer
        //修改cluster的四至
        if (p.x < cluster.attributes.extent[0]) {
          cluster.attributes.extent[0] = p.x;
        } else if (p.x > cluster.attributes.extent[2]) {
          cluster.attributes.extent[2] = p.x;
        }
        if (p.y < cluster.attributes.extent[1]) {
          cluster.attributes.extent[1] = p.y;
        } else if (p.y > cluster.attributes.extent[3]) {
          cluster.attributes.extent[3] = p.y;
        }

        // increment the count 增加++
        cluster.attributes.clusterCount++;
        // 判断对象是否含有指定的属性的
        if (!p.hasOwnProperty("attributes")) {
          p.attributes = {};
        }
        // give the graphic a cluster id 将p的clusterId设置为cluster的id
        p.attributes.clusterId = cluster.attributes.clusterId;
      },
      // point passed to clusterCreate isn't within the 
      // clustering distance specified for the layer so
      // create a new cluster for it
      //创建cluster对象
      _clusterCreate: function (p) {
        var clusterId = this._clusters.length + 1;
        // p.attributes might be undefined 如果没有定义attributes
        if (!p.attributes) {
          p.attributes = {};
        }
        p.attributes.clusterId = clusterId;
        // 创建cluster对象
        var cluster = {
          "x": p.x,
          "y": p.y,
          "attributes": {
            "clusterCount": 1,
            "clusterId": clusterId,
            "extent": [p.x, p.y, p.x, p.y]
          }
        };
        this._clusters.push(cluster);//push到聚类数组中
      },
      //显示聚类数组
      _showAllClusters: function () {
        for (var i = 0, il = this._clusters.length; i < il; i++) {
          var c = this._clusters[i];
          this._showCluster(c);
        }
      },

      _showCluster: function (c) {
        var point = new Point(c.x, c.y, this._sr);
        this.add(
          new Graphic(
            point,
            null,
            c.attributes
          )
        );
        // code below is used to not label clusters with a single point
        //如果聚类数组中的cluster对象的clusterCount为1，就不需要加label
        if (c.attributes.clusterCount == 1) {
          return;
        }

        // show number of points in the cluster
        //显示聚类点数
        var label = new TextSymbol(c.attributes.clusterCount.toString())
          .setColor(new Color(this._clusterLabelColor))
          .setOffset(0, this._clusterLabelOffset);
        this.add(
          new Graphic(
            point,
            label,
            c.attributes
          )
        );
      },

      _addSingles: function (singles) {
        // add single graphics to the map
        arrayUtils.forEach(singles, function (p) {
          var g = new Graphic(
            new Point(p.x, p.y, this._sr),
            this._singleSym,
            p.attributes,
            this._singleTemplate
          );
          this._singles.push(g);
          if (this._showSingles) {
            this.add(g);
          }
        }, this);
        this._map.infoWindow.setFeatures(this._singles);
      },

      //add方法中修改cluster的x,y
      _updateClusterGeometry: function (c) {
        // find the cluster graphic 根据clusterId在聚类数组中找到这个cluster
        var cg = arrayUtils.filter(this.graphics, function (g) {
          return !g.symbol &&
            g.attributes.clusterId == c.attributes.clusterId;
        });
        //修改这个cluster的x,y
        if (cg.length == 1) {
          cg[0].geometry.update(c.x, c.y);
        } else {
          console.log("在聚类数组中没有找到这个对象: ", cg);
        }
      },
      //add方法中修改cluster的样式
      _updateLabel: function (c) {
        // find the existing label
        var label = arrayUtils.filter(this.graphics, function (g) {
          return g.symbol &&
            g.symbol.declaredClass == "esri.symbol.TextSymbol" &&
            g.attributes.clusterId == c.attributes.clusterId;
        });
        if (label.length == 1) {
          // console.log("update label...found: ", label);
          this.remove(label[0]);
          var newLabel = new TextSymbol(c.attributes.clusterCount)
            .setColor(new Color(this._clusterLabelColor))
            .setOffset(0, this._clusterLabelOffset);
          this.add(
            new Graphic(
              new Point(c.x, c.y, this._sr),
              newLabel,
              c.attributes
            )
          );
        } else {
          console.log("在聚类数组中没有找到这个对象: ", label);
        }
      },

      // debug only...never called by the layer
      _clusterMeta: function () {
        // print total number of features
        console.log("Total:  ", this._clusterData.length);

        // add up counts and print it
        var count = 0;
        arrayUtils.forEach(this._clusters, function (c) {
          count += c.attributes.clusterCount;
        });
        console.log("In clusters:  ", count);
      }


    });
  });
