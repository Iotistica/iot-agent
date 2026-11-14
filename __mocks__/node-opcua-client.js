const unavailable = () => {
  throw new Error('OPC UA network operations must be mocked in unit tests');
};

module.exports = {
  coerceNodeId: require('node-opcua-nodeid').coerceNodeId,
  AttributeIds: {
    NodeClass: 2, BrowseName: 3, DisplayName: 4, Description: 5,
    Value: 13, DataType: 14, AccessLevel: 17, UserAccessLevel: 18,
  },
  BrowseDirection: { Forward: 0, Inverse: 1, Both: 2 },
  NodeClass: { Object: 1, Variable: 2, ObjectType: 8 },
  TimestampsToReturn: { Source: 0, Server: 1, Both: 2, Neither: 3 },
  DataType: {
    Boolean: 1, SByte: 2, Byte: 3, Int16: 4, UInt16: 5,
    Int32: 6, UInt32: 7, Int64: 8, UInt64: 9, Float: 10,
    Double: 11, String: 12,
  },
  MessageSecurityMode: { None: 1, Sign: 2, SignAndEncrypt: 3 },
  UserTokenType: { Anonymous: 0, UserName: 1 },
  OPCUAClient: { create: unavailable },
  ClientMonitoredItemGroup: { create: unavailable },
  installAlarmMonitoring: unavailable,
  uninstallAlarmMonitoring: unavailable,
};
