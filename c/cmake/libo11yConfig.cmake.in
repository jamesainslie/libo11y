# CMake package configuration for libo11y (C11)
get_filename_component(_libo11y_prefix "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)

if(NOT TARGET libo11y::o11y)
    find_library(_libo11y_lib NAMES o11y PATHS "${_libo11y_prefix}/lib" NO_DEFAULT_PATH REQUIRED)
    add_library(libo11y::o11y UNKNOWN IMPORTED)
    set_target_properties(libo11y::o11y PROPERTIES
        IMPORTED_LOCATION "${_libo11y_lib}"
        INTERFACE_INCLUDE_DIRECTORIES "${_libo11y_prefix}/include"
    )
    if(UNIX AND NOT APPLE)
        set_property(TARGET libo11y::o11y APPEND PROPERTY INTERFACE_LINK_LIBRARIES pthread m)
    endif()
endif()

if(NOT TARGET libo11y::o11ytest)
    find_library(_libo11ytest_lib NAMES o11ytest PATHS "${_libo11y_prefix}/lib" NO_DEFAULT_PATH)
    if(_libo11ytest_lib)
        add_library(libo11y::o11ytest UNKNOWN IMPORTED)
        set_target_properties(libo11y::o11ytest PROPERTIES
            IMPORTED_LOCATION "${_libo11ytest_lib}"
            INTERFACE_INCLUDE_DIRECTORIES "${_libo11y_prefix}/include"
        )
        if(UNIX AND NOT APPLE)
            set_property(TARGET libo11y::o11ytest APPEND PROPERTY INTERFACE_LINK_LIBRARIES pthread m)
        endif()
    endif()
endif()
