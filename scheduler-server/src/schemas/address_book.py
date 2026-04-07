"""
这里定义通讯录接口的响应结构。

通讯录接口会把实例、实例下的 Agent、以及群组视图一起返回，
方便前端左侧导航一次拿全。
"""
from pydantic import BaseModel


class AddressBookAgent(BaseModel):
    id: int
    agent_key: str
    cs_id: str
    display_name: str
    role_name: str | None
    enabled: bool


class AddressBookInstance(BaseModel):
    id: int
    name: str
    status: str
    agents: list[AddressBookAgent]


class AddressBookGroupMember(BaseModel):
    id: int
    instance_id: int
    agent_id: int
    display_name: str
    agent_key: str
    instance_name: str


class AddressBookGroup(BaseModel):
    id: int
    name: str
    description: str | None
    members: list[AddressBookGroupMember]


class AddressBookResponse(BaseModel):
    instances: list[AddressBookInstance]
    groups: list[AddressBookGroup]
