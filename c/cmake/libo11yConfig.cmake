# CMake package configuration for libo11y (C11)
include(CMakeFindDependencyMacro)
find_dependency(Threads)

get_filename_component(_libo11y_prefix "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)
set(_libo11y_libdir "${_libo11y_prefix}/lib")
set(_libo11y_incdir "${_libo11y_prefix}/include")

find_library(_libo11y_shared_lib
    NAMES "${CMAKE_SHARED_LIBRARY_PREFIX}o11y${CMAKE_SHARED_LIBRARY_SUFFIX}"
    PATHS "${_libo11y_libdir}"
    NO_DEFAULT_PATH
)
find_library(_libo11y_static_lib
    NAMES "${CMAKE_STATIC_LIBRARY_PREFIX}o11y${CMAKE_STATIC_LIBRARY_SUFFIX}"
    PATHS "${_libo11y_libdir}"
    NO_DEFAULT_PATH
)

if(NOT _libo11y_shared_lib AND NOT _libo11y_static_lib)
    set(libo11y_FOUND FALSE)
    set(libo11y_NOT_FOUND_MESSAGE "Could not find libo11y shared or static library in ${_libo11y_libdir}")
    unset(_libo11y_prefix)
    unset(_libo11y_libdir)
    unset(_libo11y_incdir)
    unset(_libo11y_shared_lib)
    unset(_libo11y_static_lib)
    return()
endif()

if(_libo11y_shared_lib AND NOT TARGET libo11y::o11y_shared)
    add_library(libo11y::o11y_shared SHARED IMPORTED)
    set_target_properties(libo11y::o11y_shared PROPERTIES
        IMPORTED_LOCATION "${_libo11y_shared_lib}"
        INTERFACE_INCLUDE_DIRECTORIES "${_libo11y_incdir}"
    )
    if(WIN32 AND _libo11y_static_lib)
        set_property(TARGET libo11y::o11y_shared PROPERTY IMPORTED_IMPLIB "${_libo11y_static_lib}")
    endif()
endif()

if(_libo11y_static_lib AND NOT TARGET libo11y::o11y_static)
    add_library(libo11y::o11y_static STATIC IMPORTED)
    set_target_properties(libo11y::o11y_static PROPERTIES
        IMPORTED_LOCATION "${_libo11y_static_lib}"
        INTERFACE_INCLUDE_DIRECTORIES "${_libo11y_incdir}"
    )
    set_property(TARGET libo11y::o11y_static APPEND PROPERTY INTERFACE_LINK_LIBRARIES Threads::Threads)
    if(UNIX AND NOT APPLE)
        set_property(TARGET libo11y::o11y_static APPEND PROPERTY INTERFACE_LINK_LIBRARIES m)
    endif()
endif()

if(NOT TARGET libo11y::o11y)
    add_library(libo11y::o11y INTERFACE IMPORTED)
    if(TARGET libo11y::o11y_shared AND NOT WIN32)
        set_target_properties(libo11y::o11y PROPERTIES
            INTERFACE_LINK_LIBRARIES libo11y::o11y_shared
        )
    elseif(TARGET libo11y::o11y_static)
        set_target_properties(libo11y::o11y PROPERTIES
            INTERFACE_LINK_LIBRARIES libo11y::o11y_static
        )
    else()
        set_target_properties(libo11y::o11y PROPERTIES
            INTERFACE_LINK_LIBRARIES libo11y::o11y_shared
        )
    endif()
endif()

if(NOT TARGET libo11y::o11ytest)
    find_library(_libo11ytest_lib
        NAMES "${CMAKE_STATIC_LIBRARY_PREFIX}o11ytest${CMAKE_STATIC_LIBRARY_SUFFIX}" o11ytest
        PATHS "${_libo11y_libdir}"
        NO_DEFAULT_PATH
    )
    if(_libo11ytest_lib)
        add_library(libo11y::o11ytest STATIC IMPORTED)
        set_target_properties(libo11y::o11ytest PROPERTIES
            IMPORTED_LOCATION "${_libo11ytest_lib}"
            INTERFACE_INCLUDE_DIRECTORIES "${_libo11y_incdir}"
        )
        set_property(TARGET libo11y::o11ytest APPEND PROPERTY INTERFACE_LINK_LIBRARIES Threads::Threads)
        if(UNIX AND NOT APPLE)
            set_property(TARGET libo11y::o11ytest APPEND PROPERTY INTERFACE_LINK_LIBRARIES m)
        endif()
    endif()
endif()

unset(_libo11y_prefix)
unset(_libo11y_libdir)
unset(_libo11y_incdir)
unset(_libo11y_shared_lib)
unset(_libo11y_static_lib)
unset(_libo11ytest_lib)
